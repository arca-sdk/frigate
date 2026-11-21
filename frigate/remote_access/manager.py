"""Remote access: a relay-managed Cloudflare tunnel, and Tailscale Serve.

Connect links this Frigate to an account on a relay. The relay creates a
Cloudflare tunnel and a hostname for it, and Frigate runs cloudflared with
the tunnel's token. Browsers reach Frigate through Cloudflare's edge; the
relay is not in that path. Tailscale is the private alternative: Frigate
joins the admin's tailnet as its own node and shares itself there with Serve.

Both routes point at the authenticated port, so Frigate's login protects
every remote request.
"""

import logging
import os
import shutil
import threading
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, replace
from multiprocessing.synchronize import Event as MpEvent
from typing import Any

from frigate.config import FrigateConfig
from frigate.config.holder import ConfigHolder
from frigate.const import (
    REMOTE_ACCESS_DIR,
    REMOTE_ACCESS_RELAY_URL,
    REMOTE_ACCESS_RELAY_URL_ENV_VAR,
    REMOTE_ACCESS_RUNTIME_DIR,
)
from frigate.notices import raise_notice, resolve_notice

from .cloudflared import CloudflaredConnector, ConnectorState
from .origin import LocalOrigin, origin_from_config
from .relay import LinkRequest, RelayClient, RelayError
from .state import ConnectLink, RemoteAccessState, StateStore
from .tailscale import TailscaleNode, TailscaleStatus

logger = logging.getLogger(__name__)

__all__ = ["RemoteAccessError", "RemoteAccessManager", "configured_relay_url"]

TICK = 1.0
SYNC_RETRY_DELAYS = (5.0, 15.0, 30.0, 60.0, 120.0, 300.0)
# How often to ask the relay whether the link still stands
CHECK_INTERVAL = 30 * 60.0
# At most one request for a replacement tunnel this often
RECOVERY_INTERVAL = 120.0
TAILSCALE_INTERVAL = 5.0
TAILSCALE_STATUS_MAX_AGE = 2.0
LOGIN_RETRY_INTERVAL = 60.0
SERVE_RETRY_INTERVAL = 60.0
DAEMON_START_WAIT = 10.0
MAX_NAME_LENGTH = 64
REVOKED_NOTICE = "remote_access_revoked"


class RemoteAccessError(Exception):
    """A refused request, with a message the UI can show."""

    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class PendingLink:
    relay_url: str
    name: str
    request: LinkRequest
    expires_at: float
    next_poll: float
    interval: float


def configured_relay_url() -> str | None:
    """The relay this build links to, unless the environment names another.

    Only https, because calls carry the instance secret and answers carry the
    tunnel token. Plain http is allowed for a relay on this machine, which is
    how one runs under `wrangler dev`.
    """
    value = os.environ.get(REMOTE_ACCESS_RELAY_URL_ENV_VAR, REMOTE_ACCESS_RELAY_URL)
    url = value.strip().rstrip("/")
    if not url:
        return None

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https" and parsed.hostname:
        return url
    if parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1"):
        return url

    logger.error("Ignoring the remote access relay URL %s; it must use https", url)
    return None


def clean_name(raw: str | None) -> str:
    """Strip unprintable characters from a server name and bound its length."""
    name = "".join(ch for ch in (raw or "") if ch.isprintable()).strip()
    return name[:MAX_NAME_LENGTH] or "Frigate"


class RemoteAccessManager(threading.Thread):
    def __init__(
        self,
        config: FrigateConfig,
        stop_event: MpEvent | threading.Event,
        *,
        relay_url: str | None,
        cloudflared_binary: str | None,
        tailscale_binary: str | None,
        tailscaled_binary: str | None,
        state_dir: str = REMOTE_ACCESS_DIR,
        runtime_dir: str = REMOTE_ACCESS_RUNTIME_DIR,
        relay_client: Callable[[str], RelayClient] = RelayClient,
        clock: Callable[[], float] = time.time,
        connector: CloudflaredConnector | None = None,
        tailscale_node: TailscaleNode | None = None,
        config_holder: ConfigHolder | None = None,
    ) -> None:
        super().__init__(name="remote_access")
        self.daemon = True
        self._stop_event = stop_event
        self.relay_url = relay_url
        # nginx binds its ports at startup, so a config saved later does not
        # move the origin until Frigate restarts
        self.origin: LocalOrigin = origin_from_config(config)
        # auth.enabled is read per request from the live config, which a save
        # can swap without a restart, so it is followed through the holder
        self._config_holder = config_holder or ConfigHolder(config)
        # set by apply_config before a new config goes live
        self._auth_enabled = config.auth.enabled
        # the login limiter is configured once, when the API starts
        self.login_rate_limited = config.auth.failed_login_rate_limit is not None
        self._relay_client = relay_client
        self._clock = clock
        self._store = StateStore(state_dir)
        self._lock = threading.RLock()
        # Serializes starting and stopping the connector, apart from _lock so
        # the connector's own threads can still call back while it stops
        self._connector_lock = threading.Lock()
        self._state = RemoteAccessState()
        self._generation = 0
        self._pending: PendingLink | None = None
        self._connect_error: tuple[str, str] | None = None
        self._relay_error: str | None = None
        self._sync_due: float | None = None
        self._sync_include_token = False
        self._sync_attempts = 0
        self._check_due: float | None = None
        self._last_recovery = float("-inf")
        self._connector = connector or CloudflaredConnector(
            cloudflared_binary,
            os.path.join(runtime_dir, "cloudflared"),
            on_rejected=self.request_recovery,
        )
        self._tailscale = tailscale_node or TailscaleNode(
            tailscaled_binary,
            tailscale_binary,
            state_dir=os.path.join(state_dir, "tailscale"),
            runtime_dir=os.path.join(runtime_dir, "tailscale"),
        )
        self._tailscale_lock = threading.Lock()
        # one Tailscale change at a time, maintenance included, so turning it
        # off cannot race a maintenance pass that is about to start it
        self._tailscale_op_lock = threading.RLock()
        self._tailscale_status: TailscaleStatus | None = None
        self._tailscale_serve_target: str | None = None
        self._tailscale_checked = float("-inf")
        self._tailscale_reconciled = float("-inf")
        self._last_login = float("-inf")
        self._last_serve = float("-inf")

    @classmethod
    def from_environment(
        cls, config_holder: ConfigHolder, stop_event: MpEvent
    ) -> "RemoteAccessManager":
        """Build the manager with the binaries on PATH and the configured relay."""
        return cls(
            config_holder.config,
            stop_event,
            relay_url=configured_relay_url(),
            cloudflared_binary=shutil.which("cloudflared"),
            tailscale_binary=shutil.which("tailscale"),
            tailscaled_binary=shutil.which("tailscaled"),
            config_holder=config_holder,
        )

    @property
    def auth_enabled(self) -> bool:
        # off when either the config about to go live or the live one says so
        """Whether Frigate's authentication is on, so Connect may run."""
        return self._auth_enabled and self._config_holder.config.auth.enabled

    def apply_config(self, config: FrigateConfig) -> None:
        """Take a config that is about to replace the live one.

        Called before the swap: /auth reads the live config on every request,
        so when the new one turns authentication off, the tunnel must already
        be down by the time it takes effect.
        """
        with self._connector_lock:
            with self._lock:
                self._auth_enabled = config.auth.enabled
            if not config.auth.enabled:
                if self._connector.status().state != ConnectorState.stopped:
                    logger.warning(
                        "Authentication was turned off, so remote access is off until it is back on"
                    )
                self._connector.stop()

    # Lifecycle

    def start(self) -> None:
        # load the saved link before the API can ask about it
        """Load the saved state and start the maintenance thread."""
        self.start_services()
        super().start()

    def run(self) -> None:
        """Run maintenance every second until Frigate stops."""
        while not self._stop_event.wait(TICK):
            try:
                self.run_once()
            except Exception:
                logger.exception("Remote access maintenance failed")
        self.stop_services()

    def start_services(self) -> None:
        """Load saved state and start whatever was running before."""
        state = self._store.load()
        now = self._clock()
        token = None
        with self._lock:
            generation = self._generation
            self._state = state
            link = state.connect
            if link is not None and not link.revoked:
                if self._connect_blocked_reason() is None:
                    token = link.tunnel_token
                    # the origin may have changed since the last run
                    self._schedule_sync(now)
                else:
                    logger.warning(
                        "Remote access is linked but stays off while authentication is disabled"
                    )
                self._check_due = now + CHECK_INTERVAL

        if token is not None:
            self._run_connector(generation, token)
        if state.tailscale_enabled:
            self._tailscale.start()

    def stop_services(self) -> None:
        """Stop the connector and the Tailscale node."""
        self._stop_connector()
        # Serve's configuration lives in tailscaled's state, so stopping the
        # daemon keeps it for the next start
        self._tailscale.stop()

    def run_once(self) -> None:
        """Do whatever maintenance is due: link polling, sync, checks, Tailscale."""
        now = self._clock()
        self._reconcile_connector()
        self._poll_link(now)
        self._sync(now)
        self._check(now)
        if now - self._tailscale_reconciled >= TAILSCALE_INTERVAL:
            self._tailscale_reconciled = now
            self._reconcile_tailscale(now)

    # Connect

    def start_link(self, name: str | None) -> dict[str, Any]:
        """Ask the relay for a link code for this Frigate, named as given."""
        relay_url = self._require_connect()
        with self._lock:
            link = self._state.connect
            if link is not None and not link.revoked:
                raise RemoteAccessError(
                    "already_linked", "Remote access is already set up", 409
                )

        name = clean_name(name)
        try:
            request = self._relay_client(relay_url).create_link_request(
                name, self.origin
            )
        except RelayError as err:
            logger.warning("Could not start a remote access link: %s", err.message)
            raise RemoteAccessError(
                "relay_unavailable",
                f"Could not reach the remote access service: {err.message}",
                502,
            ) from err

        now = self._clock()
        with self._lock:
            self._pending = PendingLink(
                relay_url=relay_url,
                name=name,
                request=request,
                expires_at=now + request.expires_in,
                next_poll=now + request.interval,
                interval=request.interval,
            )
            self._connect_error = None

        return self.status()

    def cancel_link(self) -> dict[str, Any]:
        """Stop waiting for a link code to be approved."""
        with self._lock:
            self._pending = None
        return self.status()

    def unlink(self) -> dict[str, Any]:
        """Turn Connect off and remove this Frigate from its account."""
        with self._lock:
            link = self._state.connect
            if link is None:
                raise RemoteAccessError(
                    "not_linked", "Remote access is not set up", 409
                )
            # saved first, so a failed write cannot leave a link that comes
            # back after a restart while the relay has already dropped it
            self._persist(replace(self._state, connect=None))
            self._generation += 1
            self._pending = None
            self._sync_due = None
            self._check_due = None
            self._connect_error = None
            self._relay_error = None

        self._stop_connector()
        resolve_notice(REVOKED_NOTICE)
        if link.revoked:
            return self.status()

        try:
            self._relay_client(link.relay_url).unlink_instance(link.instance_secret)
        except RelayError as err:
            if not err.revoked:
                logger.warning(
                    "Removed remote access here, but the relay did not confirm: %s",
                    err.message,
                )
                with self._lock:
                    self._connect_error = (
                        "unlink_incomplete",
                        "Remote access is off for this Frigate, but the remote access "
                        "service could not be reached. Remove it from your account page "
                        "as well.",
                    )
        else:
            logger.info("Remote access unlinked")

        return self.status()

    def _require_connect(self) -> str:
        if self.relay_url is None:
            raise RemoteAccessError(
                "not_configured", "This Frigate has no remote access service set", 409
            )
        if not self._connector.available:
            raise RemoteAccessError(
                "connector_missing", "cloudflared is not installed", 409
            )
        blocked = self._connect_blocked_reason()
        if blocked == "auth_disabled":
            raise RemoteAccessError(
                "auth_disabled",
                "Turn on authentication before making Frigate reachable from the internet",
                409,
            )
        return self.relay_url

    def _reconcile_connector(self) -> None:
        """Run the connector exactly while there is a usable link and auth is on."""
        with self._lock:
            link = self._state.connect
            generation = self._generation
            blocked = self._connect_blocked_reason() is not None
            wanted = link is not None and not link.revoked and not blocked
            token = link.tunnel_token if link is not None else None

        running = self._connector.status().state != ConnectorState.stopped
        if running and not wanted:
            if blocked:
                logger.warning(
                    "Authentication was turned off, so remote access is off until it is back on"
                )
            self._stop_connector()
        elif wanted and not running and token is not None:
            logger.info("Authentication is on, starting remote access again")
            self._run_connector(generation, token)

    def _connect_blocked_reason(self) -> str | None:
        # without auth, the external port lets anyone in as a viewer, or as
        # whoever the proxy headers they send claim to be
        return None if self.auth_enabled else "auth_disabled"

    def _poll_link(self, now: float) -> None:
        with self._lock:
            pending = self._pending
            if pending is None or now < pending.next_poll:
                return
            if now >= pending.expires_at:
                self._pending = None
                self._connect_error = (
                    "expired",
                    "The code expired before it was approved. Start again.",
                )
                return

        try:
            linked = self._relay_client(pending.relay_url).poll_link_request(
                pending.request.device_code
            )
        except RelayError as err:
            with self._lock:
                if self._pending is not pending:
                    return
                if err.code == "authorization_pending" or err.retryable:
                    pending.next_poll = now + pending.interval
                elif err.code == "slow_down":
                    pending.interval += 5
                    pending.next_poll = now + pending.interval
                elif err.code == "access_denied":
                    self._pending = None
                    self._connect_error = ("declined", "The link request was declined.")
                elif err.code in ("expired_token", "invalid_grant"):
                    self._pending = None
                    self._connect_error = (
                        "expired",
                        "The code expired before it was approved. Start again.",
                    )
                else:
                    self._pending = None
                    self._connect_error = (err.code, err.message)
            return

        link = ConnectLink(
            relay_url=pending.relay_url,
            instance_id=linked.instance_id,
            instance_secret=linked.instance_secret,
            tunnel_token=linked.tunnel_token,
            hostname=linked.hostname,
            url=linked.url,
            name=linked.name,
            account_label=linked.account_label,
            linked_at=now,
        )
        with self._lock:
            cancelled = self._pending is not pending
            if not cancelled:
                self._pending = None
                self._state.connect = link
                saved = self._save()
                self._generation += 1
                generation = self._generation
                self._connect_error = (
                    None
                    if saved
                    else (
                        "state_not_saved",
                        "Remote access is on, but its settings could not be saved, so "
                        "it stops when Frigate restarts. Check that /config is writable.",
                    )
                )
                self._relay_error = None
                self._sync_due = None
                self._check_due = now + CHECK_INTERVAL

        if cancelled:
            # approved after the admin gave up here; do not leave it linked
            try:
                self._relay_client(pending.relay_url).unlink_instance(
                    linked.instance_secret
                )
            except RelayError as err:
                logger.warning("Could not undo a cancelled link: %s", err.message)
            return

        self._run_connector(generation, link.tunnel_token)
        resolve_notice(REVOKED_NOTICE)
        logger.info("Remote access linked, reachable at %s", link.url)

    def _schedule_sync(self, now: float, include_token: bool = False) -> None:
        self._sync_due = now
        self._sync_include_token = self._sync_include_token or include_token

    def request_recovery(self) -> None:
        """The connector's token stopped working; ask for a replacement tunnel."""
        now = self._clock()
        with self._lock:
            link = self._state.connect
            if link is None or link.revoked:
                return
            if now - self._last_recovery < RECOVERY_INTERVAL:
                return
            self._last_recovery = now
            self._sync_attempts = 0
            self._schedule_sync(now, include_token=True)

    def _sync(self, now: float) -> None:
        with self._lock:
            link = self._state.connect
            if self._sync_due is None or now < self._sync_due or link is None:
                return
            generation = self._generation
            include_token = self._sync_include_token

        try:
            result = self._relay_client(link.relay_url).sync_instance(
                link.instance_secret,
                name=link.name,
                origin=self.origin,
                include_token=include_token,
            )
        except RelayError as err:
            if err.revoked:
                self._revoke(generation)
                return
            with self._lock:
                if generation != self._generation:
                    return
                delay = SYNC_RETRY_DELAYS[
                    min(self._sync_attempts, len(SYNC_RETRY_DELAYS) - 1)
                ]
                self._sync_attempts += 1
                self._sync_due = now + delay
                self._relay_error = err.message
            logger.warning(
                "Could not update remote access with the relay, retrying in %.0fs: %s",
                delay,
                err.message,
            )
            return

        with self._lock:
            if generation != self._generation or self._state.connect is None:
                return
            link = self._state.connect
            link.hostname = result.hostname
            link.url = result.url
            link.account_label = result.account_label
            token_changed = (
                result.tunnel_token is not None
                and result.tunnel_token != link.tunnel_token
            )
            if token_changed and result.tunnel_token is not None:
                link.tunnel_token = result.tunnel_token
            self._save()
            self._sync_due = None
            self._sync_include_token = False
            self._sync_attempts = 0
            self._relay_error = None
            token = link.tunnel_token

        if token_changed:
            logger.info("Remote access tunnel was replaced, reconnecting")
        if self._connect_blocked_reason() is None:
            # restarts the connector when the token changed, else keeps it
            self._run_connector(generation, token)

    def _check(self, now: float) -> None:
        with self._lock:
            link = self._state.connect
            if self._check_due is None or now < self._check_due or link is None:
                return
            generation = self._generation
            self._check_due = now + CHECK_INTERVAL

        try:
            self._relay_client(link.relay_url).get_instance(link.instance_secret)
        except RelayError as err:
            if err.revoked:
                self._revoke(generation)

    def _revoke(self, generation: int) -> None:
        with self._lock:
            link = self._state.connect
            if generation != self._generation or link is None or link.revoked:
                return
            link.revoked = True
            self._save()
            self._generation += 1
            self._sync_due = None
            self._check_due = None
            self._relay_error = None
            hostname = link.hostname

        self._stop_connector()
        logger.warning(
            "The remote access service no longer accepts this Frigate; %s is offline",
            hostname,
        )
        raise_notice(REVOKED_NOTICE, params={"hostname": hostname})

    def _run_connector(self, generation: int, token: str) -> None:
        with self._connector_lock:
            with self._lock:
                # unlinked, replaced, or auth turned off while this caller was busy
                if (
                    generation != self._generation
                    or self._connect_blocked_reason() is not None
                ):
                    return
            self._connector.run(token)

    def _stop_connector(self) -> None:
        with self._connector_lock:
            self._connector.stop()

    def _save(self) -> bool:
        """Save from background work, which has nobody to report to."""
        try:
            self._store.save(self._state)
        except OSError as err:
            logger.error("Could not save remote access state: %s", err)
            return False
        return True

    def _persist(self, state: RemoteAccessState) -> None:
        """Save a change an admin asked for, and only then make it current."""
        try:
            self._store.save(state)
        except OSError as err:
            logger.error("Could not save remote access state: %s", err)
            raise RemoteAccessError(
                "state_not_saved",
                "Could not save the remote access settings. Check that /config is writable.",
                500,
            ) from err
        self._state = state

    # Tailscale

    def tailscale_enable(self) -> dict[str, Any]:
        """Turn the Tailscale route on, signing in and serving Frigate as needed."""
        if not self._tailscale.available:
            raise RemoteAccessError(
                "tailscale_missing", "Tailscale is not installed", 409
            )
        with self._tailscale_op_lock:
            with self._lock:
                self._persist(replace(self._state, tailscale_enabled=True))
            self._tailscale.start()
            self._wait_for_tailscale()
            with self._tailscale_lock:
                self._last_login = float("-inf")
                self._last_serve = float("-inf")
            self._reconcile_tailscale(self._clock())
        return self.status()

    def tailscale_disable(self) -> dict[str, Any]:
        """Turn the Tailscale route off, keeping the node signed in."""
        with self._tailscale_op_lock:
            with self._lock:
                self._persist(replace(self._state, tailscale_enabled=False))
            if self._tailscale.is_started():
                self._tailscale.disable_serve()
            self._tailscale.clear_serve_attempt()
            self._tailscale.stop()
            self._forget_tailscale_status()
        return self.status()

    def tailscale_logout(self) -> dict[str, Any]:
        """Sign the Tailscale node out of its tailnet and turn the route off."""
        if not self._tailscale.available:
            raise RemoteAccessError(
                "tailscale_missing", "Tailscale is not installed", 409
            )
        with self._tailscale_op_lock:
            with self._lock:
                was_enabled = self._state.tailscale_enabled
            self._tailscale.start()
            self._wait_for_tailscale()
            self._tailscale.disable_serve()
            if not self._tailscale.logout():
                if not was_enabled:
                    # started only to sign out; nothing would stop it later
                    self._tailscale.stop()
                    self._forget_tailscale_status()
                # still signed in, so turning it off would hide that it is
                raise RemoteAccessError(
                    "tailscale_logout_failed",
                    "Could not sign out of Tailscale. Try again.",
                    502,
                )
            return self.tailscale_disable()

    def _wait_for_tailscale(self) -> None:
        deadline = time.monotonic() + DAEMON_START_WAIT
        while time.monotonic() < deadline:
            if self._tailscale.status() is not None:
                return
            time.sleep(0.25)

    def _forget_tailscale_status(self) -> None:
        with self._tailscale_lock:
            self._tailscale_status = None
            self._tailscale_serve_target = None
            self._tailscale_checked = float("-inf")

    def _refresh_tailscale_status(self) -> TailscaleStatus | None:
        status = self._tailscale.status() if self._tailscale.is_started() else None
        target = (
            self._tailscale.serve_target()
            if status is not None and status.backend_state == "Running"
            else None
        )
        with self._tailscale_lock:
            self._tailscale_status = status
            self._tailscale_serve_target = target
            self._tailscale_checked = time.monotonic()
        return status

    def _reconcile_tailscale(self, now: float) -> None:
        with self._tailscale_op_lock:
            self._reconcile_tailscale_locked(now)

    def _reconcile_tailscale_locked(self, now: float) -> None:
        with self._lock:
            enabled = self._state.tailscale_enabled
        if not enabled or not self._tailscale.available:
            return
        if not self._tailscale.is_started():
            self._tailscale.start()
            return

        status = self._refresh_tailscale_status()
        if status is None:
            return

        if (
            status.backend_state in ("NeedsLogin", "Stopped")
            and status.auth_url is None
        ):
            with self._tailscale_lock:
                due = now - self._last_login >= LOGIN_RETRY_INTERVAL
                if due:
                    self._last_login = now
            if due:
                self._tailscale.login()
                self._refresh_tailscale_status()
            return

        if status.backend_state != "Running":
            return

        with self._tailscale_lock:
            serving = self._tailscale_serve_target == self.origin.tailscale_target
        attempt = self._tailscale.serve_attempt()
        if serving or (attempt is not None and attempt.running):
            return

        with self._tailscale_lock:
            due = now - self._last_serve >= SERVE_RETRY_INTERVAL
            if due:
                self._last_serve = now
        if due:
            self._tailscale.start_serve(self.origin.tailscale_target)

    # Status

    def status(self) -> dict[str, Any]:
        """Both routes' state, as the settings page shows it."""
        return {
            "connect": self._connect_status(),
            "tailscale": self._tailscale_view(),
            "security": {
                "auth_enabled": self.auth_enabled,
                "login_rate_limit_enabled": self.login_rate_limited,
            },
            "origin": self.origin.as_dict(),
        }

    def _connect_status(self) -> dict[str, Any]:
        unavailable = None
        if self.relay_url is None:
            unavailable = "not_configured"
        elif not self._connector.available:
            unavailable = "connector_missing"

        with self._lock:
            link = self._state.connect
            pending = self._pending
            error = self._connect_error
            relay_error = self._relay_error

        if pending is not None:
            state = "linking"
        elif link is None:
            state = "unlinked"
        elif link.revoked:
            state = "revoked"
        else:
            state = "linked"

        connector = self._connector.status()
        relay_url = link.relay_url if link is not None else self.relay_url
        return {
            "available": unavailable is None,
            "unavailable_reason": unavailable,
            "blocked_reason": self._connect_blocked_reason(),
            "dashboard_url": f"{relay_url}/" if relay_url else None,
            "state": state,
            "link": {
                "user_code": pending.request.user_code,
                "verification_url": pending.request.verification_uri,
                "verification_url_complete": pending.request.verification_uri_complete,
                "expires_at": pending.expires_at,
            }
            if pending is not None
            else None,
            "name": link.name if link else None,
            "hostname": link.hostname if link else None,
            "url": link.url if link else None,
            "account_label": link.account_label if link else None,
            "linked_at": link.linked_at if link else None,
            "connector": {
                "state": connector.state.value,
                "connections": connector.connections,
                "error": connector.error
                if connector.state != ConnectorState.connected
                else None,
            },
            "relay_error": relay_error
            if connector.state != ConnectorState.connected
            else None,
            "error": {"code": error[0], "message": error[1]} if error else None,
        }

    def _tailscale_view(self) -> dict[str, Any]:
        with self._lock:
            enabled = self._state.tailscale_enabled

        view: dict[str, Any] = {
            "available": self._tailscale.available,
            "enabled": enabled,
            "state": "off",
            "auth_url": None,
            "dns_name": None,
            "tailnet": None,
            "url": None,
            "serve": "off",
            "enable_https_url": None,
            "error": None,
        }
        if not enabled or not self._tailscale.available:
            return view

        with self._tailscale_lock:
            fresh = (
                time.monotonic() - self._tailscale_checked < TAILSCALE_STATUS_MAX_AGE
            )
            status = self._tailscale_status
            target = self._tailscale_serve_target
        if not fresh:
            status = self._refresh_tailscale_status()
            with self._tailscale_lock:
                target = self._tailscale_serve_target

        if status is None:
            view["state"] = "starting"
            return view

        view["dns_name"] = status.dns_name
        view["tailnet"] = status.tailnet
        match status.backend_state:
            case "Running":
                view["state"] = "running"
            case "NeedsMachineAuth":
                view["state"] = "needs_approval"
            case "NeedsLogin" | "Stopped":
                view["state"] = "needs_login"
                view["auth_url"] = status.auth_url
            case _:
                view["state"] = "starting"

        if view["state"] != "running":
            return view

        attempt = self._tailscale.serve_attempt()
        if target == self.origin.tailscale_target:
            view["serve"] = "on"
            if status.dns_name:
                view["url"] = f"https://{status.dns_name}/"
        elif attempt is not None and attempt.running:
            view["serve"] = "needs_https" if attempt.enable_url else "enabling"
            view["enable_https_url"] = attempt.enable_url
        elif attempt is not None and attempt.error:
            view["serve"] = "error"
            view["error"] = attempt.error
        else:
            view["serve"] = "enabling"

        return view
