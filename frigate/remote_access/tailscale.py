"""A Tailscale node inside Frigate's container that shares Frigate with Serve.

tailscaled runs in userspace networking mode, so it needs no tun device or
extra container privileges, and Serve's proxy reaches Frigate on the
container's own loopback address. Its state lives in the config directory,
so the node keeps its identity across restarts and image updates.
"""

import json
import logging
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

__all__ = ["ServeAttempt", "TailscaleNode", "TailscaleStatus"]

SERVE_PORT = 443
CLI_TIMEOUT = 10.0
LOGIN_WAIT = "5s"
# Serve waits while an admin enables HTTPS for the tailnet; give them time
SERVE_ATTEMPT_TIMEOUT = 15 * 60.0
ENABLE_URL = re.compile(r"https://login\.tailscale\.com/f/\S+")


@dataclass(frozen=True)
class TailscaleStatus:
    # NoState, NeedsLogin, NeedsMachineAuth, Stopped, Starting or Running
    backend_state: str
    auth_url: str | None
    dns_name: str | None
    tailnet: str | None


@dataclass(frozen=True)
class ServeAttempt:
    running: bool
    succeeded: bool
    # Where an admin turns on HTTPS for the tailnet, when Serve needs it
    enable_url: str | None
    error: str | None


def parse_status(raw: str) -> TailscaleStatus | None:
    """Read `tailscale status --json` output, or None when it is not status."""
    try:
        status = json.loads(raw)
    except ValueError:
        return None

    if not isinstance(status, dict):
        return None

    me = status.get("Self")
    dns_name = me.get("DNSName") if isinstance(me, dict) else None
    tailnet = status.get("CurrentTailnet")
    tailnet_name = tailnet.get("Name") if isinstance(tailnet, dict) else None
    auth_url = status.get("AuthURL")
    # MagicDNS names end in a dot
    dns_name = dns_name.rstrip(".") if isinstance(dns_name, str) else None
    return TailscaleStatus(
        backend_state=str(status.get("BackendState") or "NoState"),
        auth_url=auth_url if isinstance(auth_url, str) and auth_url else None,
        dns_name=dns_name or None,
        tailnet=tailnet_name if isinstance(tailnet_name, str) else None,
    )


def parse_serve_target(raw: str, port: int = SERVE_PORT) -> str | None:
    """Return what Serve proxies the root path to on the port, if anything."""
    try:
        config = json.loads(raw)
    except ValueError:
        return None

    web = config.get("Web") if isinstance(config, dict) else None
    if not isinstance(web, dict):
        return None

    for host_port, site in web.items():
        if not str(host_port).endswith(f":{port}") or not isinstance(site, dict):
            continue
        handlers = site.get("Handlers")
        root = handlers.get("/") if isinstance(handlers, dict) else None
        proxy = root.get("Proxy") if isinstance(root, dict) else None
        if isinstance(proxy, str):
            return proxy

    return None


class TailscaleNode:
    def __init__(
        self,
        tailscaled: str | None,
        tailscale: str | None,
        state_dir: str,
        runtime_dir: str,
        hostname: str = "frigate",
    ) -> None:
        self.tailscaled = tailscaled
        self.tailscale = tailscale
        self.state_dir = state_dir
        self.runtime_dir = runtime_dir
        self.socket_path = os.path.join(runtime_dir, "tailscaled.sock")
        self.hostname = hostname
        self._lock = threading.Lock()
        self._daemon_thread: threading.Thread | None = None
        self._daemon_stop = threading.Event()
        self._daemon: subprocess.Popen[str] | None = None
        self._serve: subprocess.Popen[str] | None = None
        self._serve_enable_url: str | None = None
        self._serve_last_line: str | None = None
        self._serve_result: int | None = None

    @property
    def available(self) -> bool:
        """Whether both the tailscale and tailscaled binaries were found."""
        return self.tailscaled is not None and self.tailscale is not None

    def has_saved_identity(self) -> bool:
        """Whether the node has signed in before and kept its state."""
        return os.path.exists(os.path.join(self.state_dir, "tailscaled.state"))

    def start(self) -> None:
        """Start supervising tailscaled, unless it already runs."""
        with self._lock:
            if self._daemon_thread is not None and self._daemon_thread.is_alive():
                return
            if not self.available:
                return
            os.makedirs(self.state_dir, mode=0o700, exist_ok=True)
            os.makedirs(self.runtime_dir, mode=0o700, exist_ok=True)
            self._daemon_stop = threading.Event()
            self._daemon_thread = threading.Thread(
                target=self._supervise_daemon,
                args=(self._daemon_stop,),
                name="remote_access:tailscaled",
                daemon=True,
            )
            self._daemon_thread.start()

    def stop(self) -> None:
        """Stop any Serve attempt and tailscaled, waiting for it to exit."""
        self._stop_serve_attempt()
        with self._lock:
            thread, stop, daemon = (
                self._daemon_thread,
                self._daemon_stop,
                self._daemon,
            )
            self._daemon_thread = None

        stop.set()
        if daemon is not None:
            _terminate(daemon)
        if thread is not None:
            thread.join(timeout=15)

    def is_started(self) -> bool:
        """Whether tailscaled is being supervised."""
        with self._lock:
            return self._daemon_thread is not None and self._daemon_thread.is_alive()

    def status(self) -> TailscaleStatus | None:
        """None while the daemon is not answering."""
        result = self._cli(["status", "--json"], timeout=3)
        # status exits non-zero while logged out but still prints the JSON
        return parse_status(result.stdout) if result is not None else None

    def login(self) -> None:
        """Start signing in; the sign-in URL then appears in the status."""
        # up keeps waiting for the login to finish; the daemon carries on
        # after it gives up, so a short wait is enough to get the URL
        self._cli(
            [
                "up",
                "--json",
                f"--hostname={self.hostname}",
                f"--timeout={LOGIN_WAIT}",
            ],
            timeout=CLI_TIMEOUT,
        )

    def serve_target(self) -> str | None:
        """What Serve proxies the HTTPS root to, if anything."""
        result = self._cli(["serve", "status", "--json"], timeout=5)
        if result is None or result.returncode != 0:
            return None
        return parse_serve_target(result.stdout)

    def start_serve(self, target: str) -> None:
        """Start serving Frigate over HTTPS, in the background."""
        with self._lock:
            if self._serve is not None and self._serve.poll() is None:
                return
            if self.tailscale is None:
                return
            try:
                process = subprocess.Popen(
                    [
                        self.tailscale,
                        f"--socket={self.socket_path}",
                        "serve",
                        "--bg",
                        "--yes",
                        f"--https={SERVE_PORT}",
                        target,
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    start_new_session=True,
                )
            except OSError as err:
                self._serve_last_line = (
                    f"Could not run tailscale: {err.strerror or err}"
                )
                self._serve_result = -1
                return
            self._serve = process
            self._serve_enable_url = None
            self._serve_last_line = None
            self._serve_result = None

        threading.Thread(
            target=self._watch_serve,
            args=(process,),
            name="remote_access:tailscale_serve",
            daemon=True,
        ).start()

    def serve_attempt(self) -> ServeAttempt | None:
        """The background Serve attempt's progress, if one ran."""
        with self._lock:
            if self._serve is None and self._serve_result is None:
                return None
            running = self._serve is not None and self._serve.poll() is None
            return ServeAttempt(
                running=running,
                succeeded=self._serve_result == 0,
                enable_url=self._serve_enable_url if running else None,
                error=self._serve_last_line
                if not running and self._serve_result not in (None, 0)
                else None,
            )

    def clear_serve_attempt(self) -> None:
        """Stop and forget the background Serve attempt."""
        self._stop_serve_attempt()
        with self._lock:
            self._serve_result = None
            self._serve_last_line = None

    def disable_serve(self) -> None:
        """Stop serving on the HTTPS port."""
        self._stop_serve_attempt()
        self._cli(["serve", f"--https={SERVE_PORT}", "off"], timeout=CLI_TIMEOUT)

    def logout(self) -> bool:
        """Sign the node out of its tailnet. False when that did not happen."""
        result = self._cli(["logout"], timeout=15)
        return result is not None and result.returncode == 0

    def _stop_serve_attempt(self) -> None:
        with self._lock:
            process = self._serve
            self._serve = None
        if process is not None:
            _terminate(process)

    def _watch_serve(self, process: subprocess.Popen[str]) -> None:
        deadline = time.monotonic() + SERVE_ATTEMPT_TIMEOUT
        timer = threading.Timer(SERVE_ATTEMPT_TIMEOUT, _terminate, args=(process,))
        timer.daemon = True
        timer.start()
        assert process.stdout is not None
        for raw in process.stdout:
            line = raw.strip()
            if not line:
                continue
            logger.debug("tailscale serve: %s", line)
            with self._lock:
                enable = ENABLE_URL.search(line)
                if enable:
                    self._serve_enable_url = enable.group(0)
                else:
                    self._serve_last_line = line

        code = process.wait()
        timer.cancel()
        with self._lock:
            if self._serve is process:
                self._serve = None
            self._serve_result = code
            if code != 0 and time.monotonic() >= deadline:
                self._serve_last_line = "Timed out waiting for HTTPS to be enabled"

    def _supervise_daemon(self, stop: threading.Event) -> None:
        delay = 2.0
        while not stop.is_set():
            started = time.monotonic()
            try:
                process = subprocess.Popen(
                    [
                        self.tailscaled or "tailscaled",
                        "--tun=userspace-networking",
                        f"--statedir={self.state_dir}",
                        f"--socket={self.socket_path}",
                        "--port=0",
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    start_new_session=True,
                )
            except OSError as err:
                logger.error("Could not start tailscaled for remote access: %s", err)
                if stop.wait(delay):
                    break
                delay = min(delay * 2, 60.0)
                continue

            with self._lock:
                if stop.is_set():
                    _terminate(process)
                    break
                self._daemon = process

            assert process.stdout is not None
            for raw in process.stdout:
                if raw.strip():
                    logger.debug("tailscaled: %s", raw.rstrip())

            process.wait()
            with self._lock:
                self._daemon = None
            if stop.is_set():
                break

            if time.monotonic() - started >= 60:
                delay = 2.0
            logger.warning(
                "tailscaled exited with code %s, restarting in %.0fs",
                process.returncode,
                delay,
            )
            if stop.wait(delay):
                break
            delay = min(delay * 2, 60.0)

    def _cli(
        self, args: list[str], timeout: float
    ) -> subprocess.CompletedProcess[str] | None:
        if self.tailscale is None:
            return None
        try:
            return subprocess.run(
                [self.tailscale, f"--socket={self.socket_path}", *args],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as err:
            logger.debug("tailscale %s failed: %s", args[0], err)
            return None


def _terminate(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
