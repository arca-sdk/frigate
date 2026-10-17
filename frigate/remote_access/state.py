"""Remote access credentials and choices kept in the config directory."""

import json
import logging
import os
import tempfile
from dataclasses import asdict, dataclass
from typing import Any

logger = logging.getLogger(__name__)

__all__ = ["ConnectLink", "RemoteAccessState", "StateStore"]

STATE_FILE = "state.json"
STATE_VERSION = 1


@dataclass
class ConnectLink:
    """A link to a relay account, with what the connector needs to run."""

    relay_url: str
    instance_id: str
    instance_secret: str
    tunnel_token: str
    hostname: str
    url: str
    name: str
    account_label: str | None
    linked_at: float
    # Set when the relay no longer accepts this link, such as after the
    # account owner removed it. Kept so the UI can say so.
    revoked: bool = False


@dataclass
class RemoteAccessState:
    connect: ConnectLink | None = None
    # Whether the admin turned Tailscale on, so it starts again after a restart
    tailscale_enabled: bool = False


class StateStore:
    """Reads and writes the state file, readable only by Frigate's user."""

    def __init__(self, directory: str) -> None:
        self.directory = directory
        self.path = os.path.join(directory, STATE_FILE)

    def ensure_directory(self) -> None:
        """Create the state directory, readable only by Frigate's user."""
        os.makedirs(self.directory, mode=0o700, exist_ok=True)

    def load(self) -> RemoteAccessState:
        """Read the saved state, or an empty one when it is missing or unreadable."""
        try:
            with open(self.path, encoding="utf-8") as file:
                raw = json.load(file)
        except FileNotFoundError:
            return RemoteAccessState()
        except (OSError, ValueError) as err:
            logger.error("Could not read remote access state %s: %s", self.path, err)
            return RemoteAccessState()

        return self._parse(raw)

    def save(self, state: RemoteAccessState) -> None:
        """Write the state atomically, readable only by Frigate's user."""
        self.ensure_directory()
        payload = {
            "version": STATE_VERSION,
            "connect": asdict(state.connect) if state.connect else None,
            "tailscale_enabled": state.tailscale_enabled,
        }
        # mkstemp creates the file with mode 0600, and the rename means a
        # crash leaves either the old state or the new one, never half
        descriptor, temporary = tempfile.mkstemp(
            dir=self.directory, prefix=".state-", suffix=".json"
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                json.dump(payload, file, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def _parse(self, raw: Any) -> RemoteAccessState:
        if not isinstance(raw, dict):
            logger.error("Ignoring remote access state with an unexpected format")
            return RemoteAccessState()

        connect = None
        if isinstance(raw.get("connect"), dict):
            try:
                connect = ConnectLink(**raw["connect"])
            except TypeError as err:
                logger.error("Ignoring an unreadable remote access link: %s", err)

        return RemoteAccessState(
            connect=connect,
            tailscale_enabled=raw.get("tailscale_enabled") is True,
        )
