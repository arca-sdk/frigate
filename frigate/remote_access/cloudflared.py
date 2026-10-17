"""Runs cloudflared for the linked tunnel and tracks whether it is connected."""

import logging
import os
import re
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

import requests

logger = logging.getLogger(__name__)

__all__ = ["CloudflaredConnector", "ConnectorState", "ConnectorStatus"]

METRICS_LINE = re.compile(r"\bStarting metrics server on (127\.0\.0\.1:\d+)/metrics\b")
REGISTERED_LINE = re.compile(r"\bRegistered tunnel connection\b", re.IGNORECASE)
# The edge words a rejected tunnel several ways, sometimes prefixed with
# "Unauthorized:". Any of them means this token no longer works.
REJECTED_LINE = re.compile(
    r"\bRegister tunnel error from server side\b.*"
    r'error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found'
    r'|Record for tunnel not found|Invalid tunnel secret)"',
    re.IGNORECASE,
)
ERROR_LINE = re.compile(r"\s(?:ERR|FTL|PNC)\s+(.*)$")

REJECTIONS_BEFORE_RECOVERY = 3
# A connector that never connects within this long counts as disconnected
STARTUP_GRACE = 60.0
# A process that ran at least this long was healthy, so restarts start fast again
HEALTHY_RUN = 60.0


def summarize_error(message: str) -> str:
    """Keep the part of a cloudflared error line worth showing an admin.

    Lines end in key=value context such as connIndex and the edge IP; the
    error value, when present, is the useful part.
    """
    quoted = re.search(r'\berror="([^"]+)"', message)
    if quoted:
        return quoted.group(1)

    return re.split(r"\s+\w+=", message, maxsplit=1)[0].strip()


class ConnectorState(str, Enum):
    stopped = "stopped"
    starting = "starting"
    connected = "connected"
    disconnected = "disconnected"
    failed = "failed"


@dataclass(frozen=True)
class ConnectorStatus:
    state: ConnectorState
    connections: int
    error: str | None


class CloudflaredConnector:
    """Supervises one cloudflared process for one tunnel token.

    The token travels in the environment, not the command line, because
    Frigate's stats publish the command lines of the processes it watches.
    """

    def __init__(
        self,
        binary: str | None,
        runtime_dir: str,
        on_rejected: Callable[[], None],
        ready_poll_interval: float = 5.0,
        restart_delays: tuple[float, float] = (2.0, 60.0),
    ) -> None:
        self.binary = binary
        self._runtime_dir = runtime_dir
        self._on_rejected = on_rejected
        self._ready_poll_interval = ready_poll_interval
        self._restart_delays = restart_delays
        self._lock = threading.Lock()
        self._token: str | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._process: subprocess.Popen[str] | None = None
        self._state = ConnectorState.stopped
        self._connections = 0
        self._error: str | None = None
        self._metrics_address: str | None = None
        self._started_at = 0.0

    @property
    def available(self) -> bool:
        return self.binary is not None

    def run(self, token: str) -> None:
        """Run the connector for this token, replacing one for another token."""
        with self._lock:
            if (
                self._token == token
                and self._thread is not None
                and self._thread.is_alive()
            ):
                return

        self.stop()
        if self.binary is None:
            with self._lock:
                self._state = ConnectorState.failed
                self._error = "cloudflared is not installed"
            return

        with self._lock:
            self._token = token
            self._stop = threading.Event()
            self._state = ConnectorState.starting
            self._connections = 0
            self._error = None
            self._thread = threading.Thread(
                target=self._supervise,
                args=(token, self._stop),
                name="remote_access:cloudflared",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            thread, stop, process = self._thread, self._stop, self._process
            self._thread = None
            self._token = None

        stop.set()
        if process is not None:
            self._terminate(process)

        if thread is not None:
            thread.join(timeout=15)

        with self._lock:
            self._state = ConnectorState.stopped
            self._connections = 0
            self._error = None

    def status(self) -> ConnectorStatus:
        with self._lock:
            return ConnectorStatus(self._state, self._connections, self._error)

    def _supervise(self, token: str, stop: threading.Event) -> None:
        delay = self._restart_delays[0]
        os.makedirs(self._runtime_dir, mode=0o700, exist_ok=True)
        while not stop.is_set():
            started = time.monotonic()
            try:
                process = subprocess.Popen(
                    [
                        self.binary or "cloudflared",
                        "tunnel",
                        "--no-autoupdate",
                        "--loglevel",
                        "info",
                        "--grace-period",
                        "5s",
                        "--metrics",
                        "127.0.0.1:0",
                        "run",
                    ],
                    # A HOME of its own, so a stray ~/.cloudflared/config.yml
                    # in /config cannot change what the tunnel serves
                    env={
                        **os.environ,
                        "HOME": self._runtime_dir,
                        "TUNNEL_TOKEN": token,
                    },
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    start_new_session=True,
                )
            except OSError as err:
                logger.error("Could not start cloudflared for remote access: %s", err)
                with self._lock:
                    self._state = ConnectorState.failed
                    self._error = f"Could not start cloudflared: {err.strerror or err}"
                if stop.wait(delay):
                    break
                delay = min(delay * 2, self._restart_delays[1])
                continue

            with self._lock:
                if stop.is_set():
                    self._terminate(process)
                    break
                self._process = process
                self._metrics_address = None
                self._started_at = started

            reader = threading.Thread(
                target=self._read_output,
                args=(process, token),
                name="remote_access:cloudflared_output",
                daemon=True,
            )
            reader.start()

            while True:
                try:
                    process.wait(timeout=self._ready_poll_interval)
                    break
                except subprocess.TimeoutExpired:
                    if stop.is_set():
                        break
                    self._check_ready()

            if stop.is_set():
                self._terminate(process)
                reader.join(timeout=5)
                break

            reader.join(timeout=5)
            with self._lock:
                self._process = None
                self._connections = 0
                self._state = ConnectorState.failed
                self._error = self._error or (
                    f"cloudflared exited with code {process.returncode}"
                )

            if time.monotonic() - started >= HEALTHY_RUN:
                delay = self._restart_delays[0]
            logger.warning(
                "Remote access connector exited with code %s, restarting in %.0fs",
                process.returncode,
                delay,
            )
            if stop.wait(delay):
                break
            delay = min(delay * 2, self._restart_delays[1])

    def _check_ready(self) -> None:
        with self._lock:
            address = self._metrics_address
        if address is None:
            return

        try:
            response = requests.get(f"http://{address}/ready", timeout=2)
            ready = response.json().get("readyConnections")
        except (requests.RequestException, ValueError, AttributeError):
            return

        if not isinstance(ready, int):
            return

        with self._lock:
            was_connected = self._state == ConnectorState.connected
            self._connections = ready
            if ready > 0:
                self._state = ConnectorState.connected
                self._error = None
            elif was_connected or (time.monotonic() - self._started_at > STARTUP_GRACE):
                self._state = ConnectorState.disconnected

        if was_connected and ready == 0:
            logger.warning("Remote access tunnel lost its connection to Cloudflare")

    def _read_output(self, process: subprocess.Popen[str], token: str) -> None:
        rejections = 0
        announced = False
        assert process.stdout is not None
        for raw in process.stdout:
            line = raw.rstrip().replace(token, "<redacted>")
            if not line:
                continue

            logger.debug("cloudflared: %s", line)
            metrics = METRICS_LINE.search(line)
            if metrics:
                with self._lock:
                    self._metrics_address = metrics.group(1)
                continue

            if REGISTERED_LINE.search(line):
                rejections = 0
                with self._lock:
                    self._state = ConnectorState.connected
                    self._connections = max(self._connections, 1)
                    self._error = None
                if not announced:
                    logger.info("Remote access tunnel connected")
                    announced = True
                continue

            if REJECTED_LINE.search(line):
                rejections += 1
                if rejections >= REJECTIONS_BEFORE_RECOVERY:
                    rejections = 0
                    logger.warning(
                        "Cloudflare rejected the remote access tunnel, asking the relay for a new one"
                    )
                    self._on_rejected()

            error = ERROR_LINE.search(line)
            if error:
                with self._lock:
                    self._error = summarize_error(error.group(1))

    @staticmethod
    def _terminate(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return

        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
