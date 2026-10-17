"""Client for the relay that links Frigate to an account and manages its tunnel."""

from dataclasses import dataclass
from typing import Any

import requests

from frigate.version import VERSION

from .origin import LocalOrigin

__all__ = ["LinkRequest", "LinkedInstance", "RelayClient", "RelayError", "SyncResult"]

REQUEST_TIMEOUT = (5.0, 20.0)


class RelayError(Exception):
    """A relay call that failed, with the relay's error code when it sent one."""

    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    @property
    def revoked(self) -> bool:
        """The relay no longer accepts this Frigate's credentials."""
        return self.status == 401

    @property
    def retryable(self) -> bool:
        """Whether the same call may succeed later, such as after an outage."""
        return self.status is None or self.status == 429 or self.status >= 500


@dataclass(frozen=True)
class LinkRequest:
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: float
    interval: float


@dataclass(frozen=True)
class LinkedInstance:
    instance_id: str
    instance_secret: str
    tunnel_token: str
    hostname: str
    url: str
    name: str
    account_label: str | None


@dataclass(frozen=True)
class SyncResult:
    hostname: str
    url: str
    name: str
    account_label: str | None
    # Only set when the tunnel was replaced or a token was asked for
    tunnel_token: str | None
    tunnel_replaced: bool


def _require_str(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value:
        raise RelayError("bad_response", f"The relay's response has no {key}")

    return value


def _optional_str(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) and value else None


class RelayClient:
    def __init__(self, base_url: str, session: requests.Session | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._session = session or requests.Session()

    def create_link_request(self, name: str, origin: LocalOrigin) -> LinkRequest:
        """Ask for a code that links this Frigate to an account."""
        body = self._call(
            "POST",
            "/v1/link-requests",
            json={"name": name, "origin": origin.as_dict()},
        )
        expires_in = body.get("expires_in")
        interval = body.get("interval")
        return LinkRequest(
            device_code=_require_str(body, "device_code"),
            user_code=_require_str(body, "user_code"),
            verification_uri=_require_str(body, "verification_uri"),
            verification_uri_complete=_require_str(body, "verification_uri_complete"),
            expires_in=expires_in if isinstance(expires_in, (int, float)) else 600,
            interval=interval if isinstance(interval, (int, float)) else 5,
        )

    def poll_link_request(self, device_code: str) -> LinkedInstance:
        """Raise RelayError with authorization_pending until the code is approved."""
        body = self._call(
            "POST", "/v1/link-requests/token", json={"device_code": device_code}
        )
        return LinkedInstance(
            instance_id=_require_str(body, "instance_id"),
            instance_secret=_require_str(body, "instance_secret"),
            tunnel_token=_require_str(body, "tunnel_token"),
            hostname=_require_str(body, "hostname"),
            url=_require_str(body, "url"),
            name=_require_str(body, "name"),
            account_label=_optional_str(body, "account_label"),
        )

    def get_instance(self, secret: str) -> dict[str, Any]:
        """Read this Frigate's link; raises a revoked RelayError once it is gone."""
        return self._call("GET", "/v1/instance", secret=secret)

    def sync_instance(
        self, secret: str, *, name: str, origin: LocalOrigin, include_token: bool
    ) -> SyncResult:
        """Repair the tunnel, follow the origin, and maybe get a new token."""
        body = self._call(
            "POST",
            "/v1/instance/sync",
            secret=secret,
            json={
                "name": name,
                "origin": origin.as_dict(),
                "include_token": include_token,
            },
        )
        return SyncResult(
            hostname=_require_str(body, "hostname"),
            url=_require_str(body, "url"),
            name=_require_str(body, "name"),
            account_label=_optional_str(body, "account_label"),
            tunnel_token=_optional_str(body, "tunnel_token"),
            tunnel_replaced=body.get("tunnel_replaced") is True,
        )

    def unlink_instance(self, secret: str) -> None:
        """Remove this Frigate from its account, with its tunnel and hostname."""
        self._call("DELETE", "/v1/instance", secret=secret)

    def _call(
        self,
        method: str,
        path: str,
        *,
        secret: str | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        headers = {"user-agent": f"Frigate/{VERSION} remote-access"}
        if secret is not None:
            headers["authorization"] = f"Bearer {secret}"

        try:
            response = self._session.request(
                method,
                f"{self.base_url}{path}",
                headers=headers,
                json=json,
                timeout=REQUEST_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException as err:
            raise RelayError(
                "unreachable", f"Could not reach {self.base_url}: {type(err).__name__}"
            ) from err

        if response.status_code == 204:
            return {}

        try:
            body = response.json()
        except ValueError:
            body = None

        if not isinstance(body, dict):
            raise RelayError(
                "bad_response",
                f"The relay answered with HTTP {response.status_code}",
                response.status_code,
            )

        if response.status_code >= 400:
            code = body.get("error")
            message = body.get("message")
            raise RelayError(
                code if isinstance(code, str) else "relay_error",
                message
                if isinstance(message, str)
                else f"The relay answered with HTTP {response.status_code}",
                response.status_code,
            )

        return body
