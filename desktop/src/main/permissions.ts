/** Which browser permissions a server's pages may use. */

import { isSameOrigin } from "./serverUrl";

/**
 * Permissions the Frigate UI needs: fullscreen for camera views and copying
 * text. Notifications stay off because the UI would try web push, which
 * Electron doesn't support.
 */
const ALLOWED_PERMISSIONS = new Set([
  "fullscreen",
  "clipboard-sanitized-write",
]);

/**
 * Decide a permission request or check from a server window.
 *
 * Only the server's own origin is granted anything. Media is limited to the
 * microphone, which two-way talk uses; the UI never asks for the camera.
 */
export function isPermissionAllowed(
  permission: string,
  requestingUrl: string,
  serverUrl: string,
  mediaTypes: readonly string[] = [],
): boolean {
  if (!isSameOrigin(requestingUrl, serverUrl)) {
    return false;
  }

  if (permission === "media") {
    return (
      mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio")
    );
  }

  return ALLOWED_PERMISSIONS.has(permission);
}
