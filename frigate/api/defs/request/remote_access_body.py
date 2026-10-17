from pydantic import BaseModel, Field


class RemoteAccessLinkBody(BaseModel):
    # how this Frigate is listed on the account; trimmed to 64 characters
    name: str | None = Field(default=None, max_length=256)
