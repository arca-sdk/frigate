import { describe, expect, it } from "vitest";

import { isPermissionAllowed } from "../src/main/permissions";

const server = "https://frigate.local:8971/";

describe("isPermissionAllowed", () => {
  it("grants fullscreen and clipboard writes to the server", () => {
    expect(
      isPermissionAllowed(
        "fullscreen",
        "https://frigate.local:8971/#front",
        server,
      ),
    ).toBe(true);
    expect(
      isPermissionAllowed("clipboard-sanitized-write", server, server),
    ).toBe(true);
  });

  it("grants the microphone but not the camera", () => {
    expect(isPermissionAllowed("media", server, server, ["audio"])).toBe(true);
    expect(
      isPermissionAllowed("media", server, server, ["audio", "video"]),
    ).toBe(false);
    expect(isPermissionAllowed("media", server, server, [])).toBe(false);
  });

  it("refuses everything else, including notifications", () => {
    for (const permission of [
      "notifications",
      "geolocation",
      "clipboard-read",
      "openExternal",
    ]) {
      expect(isPermissionAllowed(permission, server, server)).toBe(false);
    }
  });

  it("refuses other origins", () => {
    expect(
      isPermissionAllowed("fullscreen", "https://evil.example/", server),
    ).toBe(false);
  });
});
