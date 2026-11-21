"""Remote access APIs."""

import logging
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import require_role
from frigate.api.defs.request.remote_access_body import RemoteAccessLinkBody
from frigate.api.defs.tags import Tags
from frigate.remote_access import RemoteAccessError, RemoteAccessManager

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.remote_access])


def _respond(
    request: Request, action: Callable[[RemoteAccessManager], dict[str, Any]]
) -> JSONResponse:
    manager: RemoteAccessManager | None = getattr(request.app, "remote_access", None)
    if manager is None:
        return JSONResponse(
            content={"success": False, "message": "Remote access is not running"},
            status_code=503,
        )

    try:
        status = action(manager)
    except RemoteAccessError as err:
        return JSONResponse(
            content={"success": False, "code": err.code, "message": err.message},
            status_code=err.status_code,
        )

    return JSONResponse(content=status)


@router.get("/remote_access", dependencies=[Depends(require_role(["admin"]))])
def get_remote_access(request: Request) -> JSONResponse:
    """Get the state of the Connect and Tailscale routes.

    Returns:
        Both routes' state, and the auth settings remote access depends on
    """
    return _respond(request, lambda manager: manager.status())


@router.post(
    "/remote_access/connect/link", dependencies=[Depends(require_role(["admin"]))]
)
def start_connect_link(request: Request, body: RemoteAccessLinkBody) -> JSONResponse:
    """Ask the relay for a code that links this Frigate to an account.

    Frigate polls the relay until the code is approved there, then starts
    the tunnel.

    Args:
        body: The name to list this Frigate under on the account

    Returns:
        The state, with the code and the page to approve it on
    """
    return _respond(request, lambda manager: manager.start_link(body.name))


@router.delete(
    "/remote_access/connect/link", dependencies=[Depends(require_role(["admin"]))]
)
def cancel_connect_link(request: Request) -> JSONResponse:
    """Stop waiting for a link code to be approved."""
    return _respond(request, lambda manager: manager.cancel_link())


@router.delete(
    "/remote_access/connect", dependencies=[Depends(require_role(["admin"]))]
)
def unlink_connect(request: Request) -> JSONResponse:
    """Stop the tunnel and remove this Frigate from its account."""
    return _respond(request, lambda manager: manager.unlink())


@router.post(
    "/remote_access/tailscale/enable", dependencies=[Depends(require_role(["admin"]))]
)
def enable_tailscale(request: Request) -> JSONResponse:
    """Start the Tailscale node, signing in if needed, and serve Frigate on it."""
    return _respond(request, lambda manager: manager.tailscale_enable())


@router.post(
    "/remote_access/tailscale/disable",
    dependencies=[Depends(require_role(["admin"]))],
)
def disable_tailscale(request: Request) -> JSONResponse:
    """Stop serving Frigate on the tailnet, keeping the node signed in."""
    return _respond(request, lambda manager: manager.tailscale_disable())


@router.post(
    "/remote_access/tailscale/logout",
    dependencies=[Depends(require_role(["admin"]))],
)
def logout_tailscale(request: Request) -> JSONResponse:
    """Sign the node out of the tailnet and turn Tailscale off."""
    return _respond(request, lambda manager: manager.tailscale_logout())
