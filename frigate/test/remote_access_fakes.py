"""Stand-ins for the relay, the connector and the Tailscale node."""

import itertools
from dataclasses import dataclass, field
from typing import Any

from frigate.remote_access.cloudflared import ConnectorState, ConnectorStatus
from frigate.remote_access.origin import LocalOrigin
from frigate.remote_access.relay import (
    LinkedInstance,
    LinkRequest,
    RelayError,
    SyncResult,
)
from frigate.remote_access.tailscale import ServeAttempt, TailscaleStatus


@dataclass
class _Request:
    user_code: str
    name: str
    origin: LocalOrigin
    status: str = "pending"


@dataclass
class _Instance:
    instance_id: str
    secret: str
    name: str
    hostname: str
    tunnel_token: str
    origin: LocalOrigin
    account_label: str | None = "alice@example.com"


@dataclass
class FakeRelay:
    """Follows the relay's protocol, including its error codes."""

    requests: dict[str, _Request] = field(default_factory=dict)
    instances: dict[str, _Instance] = field(default_factory=dict)
    calls: list[tuple[str, str]] = field(default_factory=list)
    failures: dict[str, RelayError] = field(default_factory=dict)
    _ids: Any = field(default_factory=lambda: itertools.count(1))

    def client(self, base_url: str) -> "FakeRelayClient":
        return FakeRelayClient(self, base_url)

    def fail_next(self, method: str, error: RelayError) -> None:
        self.failures[method] = error

    def approve(self, user_code: str) -> None:
        self._request_for(user_code).status = "approved"

    def deny(self, user_code: str) -> None:
        self._request_for(user_code).status = "denied"

    def remove_instance(self, instance_id: str) -> None:
        for secret, instance in list(self.instances.items()):
            if instance.instance_id == instance_id:
                del self.instances[secret]

    def replace_tunnel(self, instance_id: str) -> str:
        instance = next(
            i for i in self.instances.values() if i.instance_id == instance_id
        )
        instance.tunnel_token = f"token-{next(self._ids)}"
        return instance.tunnel_token

    def instance(self) -> _Instance:
        (only,) = self.instances.values()
        return only

    def _request_for(self, user_code: str) -> _Request:
        return next(r for r in self.requests.values() if r.user_code == user_code)

    def _enter(self, method: str, base_url: str) -> None:
        self.calls.append((method, base_url))
        failure = self.failures.pop(method, None)
        if failure is not None:
            raise failure


class FakeRelayClient:
    def __init__(self, relay: FakeRelay, base_url: str) -> None:
        self.relay = relay
        self.base_url = base_url

    def create_link_request(self, name: str, origin: LocalOrigin) -> LinkRequest:
        self.relay._enter("create_link_request", self.base_url)
        number = next(self.relay._ids)
        device_code = f"device-{number}"
        user_code = f"BCDF-{number:04d}"
        self.relay.requests[device_code] = _Request(user_code, name, origin)
        return LinkRequest(
            device_code=device_code,
            user_code=user_code,
            verification_uri=f"{self.base_url}/link",
            verification_uri_complete=f"{self.base_url}/link?code={user_code}",
            expires_in=600,
            interval=5,
        )

    def poll_link_request(self, device_code: str) -> LinkedInstance:
        self.relay._enter("poll_link_request", self.base_url)
        request = self.relay.requests.get(device_code)
        if request is None:
            raise RelayError("invalid_grant", "Unknown link request", 400)
        if request.status == "denied":
            del self.relay.requests[device_code]
            raise RelayError("access_denied", "The link request was declined", 400)
        if request.status == "pending":
            raise RelayError("authorization_pending", "Waiting for approval", 400)

        number = next(self.relay._ids)
        instance = _Instance(
            instance_id=f"inst{number}",
            secret=f"inst{number}.secret",
            name=request.name,
            hostname=f"inst{number}.tunnels.example.net",
            tunnel_token=f"token-{number}",
            origin=request.origin,
        )
        self.relay.instances[instance.secret] = instance
        return LinkedInstance(
            instance_id=instance.instance_id,
            instance_secret=instance.secret,
            tunnel_token=instance.tunnel_token,
            hostname=instance.hostname,
            url=f"https://{instance.hostname}/",
            name=instance.name,
            account_label=instance.account_label,
        )

    def get_instance(self, secret: str) -> dict[str, Any]:
        self.relay._enter("get_instance", self.base_url)
        instance = self._authenticate(secret)
        return {"instance_id": instance.instance_id, "hostname": instance.hostname}

    def sync_instance(
        self, secret: str, *, name: str, origin: LocalOrigin, include_token: bool
    ) -> SyncResult:
        self.relay._enter("sync_instance", self.base_url)
        instance = self._authenticate(secret)
        instance.name = name
        instance.origin = origin
        return SyncResult(
            hostname=instance.hostname,
            url=f"https://{instance.hostname}/",
            name=instance.name,
            account_label=instance.account_label,
            tunnel_token=instance.tunnel_token,
            tunnel_replaced=False,
        )

    def unlink_instance(self, secret: str) -> None:
        self.relay._enter("unlink_instance", self.base_url)
        self._authenticate(secret)
        del self.relay.instances[secret]

    def _authenticate(self, secret: str) -> _Instance:
        instance = self.relay.instances.get(secret)
        if instance is None:
            raise RelayError(
                "invalid_instance_credentials", "This Frigate is no longer linked", 401
            )
        return instance


class FakeConnector:
    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.token: str | None = None
        self.runs: list[str] = []
        self.state = ConnectorState.stopped

    def run(self, token: str) -> None:
        if self.token != token:
            self.runs.append(token)
        self.token = token
        self.state = ConnectorState.connected

    def stop(self) -> None:
        self.token = None
        self.state = ConnectorState.stopped

    def status(self) -> ConnectorStatus:
        return ConnectorStatus(self.state, 4 if self.token else 0, None)


class FakeTailscale:
    """A node whose login and Serve succeed when the test says so."""

    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.started = False
        self.backend_state = "NeedsLogin"
        self.auth_url: str | None = None
        self.dns_name = "frigate.tail1234.ts.net"
        self.target: str | None = None
        self.attempt: ServeAttempt | None = None
        self.logins = 0
        self.serve_starts: list[str] = []
        self.logged_out = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.started = False

    def is_started(self) -> bool:
        return self.started

    def status(self) -> TailscaleStatus | None:
        if not self.started:
            return None
        return TailscaleStatus(
            backend_state=self.backend_state,
            auth_url=self.auth_url,
            dns_name=self.dns_name if self.backend_state == "Running" else None,
            tailnet="example.com" if self.backend_state == "Running" else None,
        )

    def login(self) -> None:
        self.logins += 1
        self.auth_url = "https://login.tailscale.com/a/abc123"

    def complete_login(self) -> None:
        self.backend_state = "Running"
        self.auth_url = None

    def serve_target(self) -> str | None:
        return self.target

    def start_serve(self, target: str) -> None:
        self.serve_starts.append(target)
        self.attempt = ServeAttempt(
            running=True, succeeded=False, enable_url=None, error=None
        )

    def finish_serve(self, target: str) -> None:
        self.target = target
        self.attempt = ServeAttempt(
            running=False, succeeded=True, enable_url=None, error=None
        )

    def serve_attempt(self) -> ServeAttempt | None:
        return self.attempt

    def clear_serve_attempt(self) -> None:
        self.attempt = None

    def disable_serve(self) -> None:
        self.target = None
        self.attempt = None

    def logout(self) -> None:
        self.logged_out = True
        self.backend_state = "NeedsLogin"
