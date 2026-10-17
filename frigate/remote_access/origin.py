"""The local listener that remote access routes to."""

import ipaddress
from dataclasses import dataclass
from typing import Literal

from frigate.config import FrigateConfig

__all__ = ["LocalOrigin", "origin_from_config"]


@dataclass(frozen=True)
class LocalOrigin:
    """Frigate's authenticated listener, as seen from inside its container."""

    scheme: Literal["http", "https"]
    host: str
    port: int

    @property
    def url(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{self.scheme}://{host}:{self.port}"

    @property
    def tailscale_target(self) -> str:
        """The Serve target; the default certificate is self-signed."""
        if self.scheme == "https":
            return "https+insecure://" + self.url.removeprefix("https://")

        return self.url

    def as_dict(self) -> dict[str, str | int]:
        return {"scheme": self.scheme, "host": self.host, "port": self.port}


def origin_from_config(config: FrigateConfig) -> LocalOrigin:
    """Return the authenticated port nginx listens on.

    Never the internal port: nginx treats every request on it as an admin,
    so a tunnel to it would hand the internet an admin session.
    """
    listen = config.networking.listen.external
    host = "127.0.0.1"
    if isinstance(listen, str) and ":" in listen:
        address = listen.rsplit(":", 1)[0].strip("[]")
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            parsed = None

        # nginx only answers on that address, so loopback would not reach it
        if parsed is not None and not parsed.is_unspecified:
            host = str(parsed)

    return LocalOrigin(
        scheme="https" if config.tls.enabled else "http",
        host=host,
        port=config.networking.listen.external_port,
    )
