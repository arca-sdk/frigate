"""Reach Frigate from outside the local network without opening ports."""

from .manager import RemoteAccessError, RemoteAccessManager

__all__ = ["RemoteAccessError", "RemoteAccessManager"]
