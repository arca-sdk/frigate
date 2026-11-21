/** Formatting helpers for the server list page. */

/**
 * Show Electron's "sha256/<base64>" fingerprint the way
 * `openssl x509 -noout -fingerprint -sha256` prints it, so it can be compared
 * with the certificate on the server.
 */
export function formatFingerprint(fingerprint: string): string {
  const prefix = "sha256/";

  if (!fingerprint.startsWith(prefix)) {
    return fingerprint;
  }

  let bytes: string;

  try {
    // Base64 itself can contain "/", so take everything after the prefix.
    bytes = atob(fingerprint.slice(prefix.length));
  } catch {
    return fingerprint;
  }

  return Array.from(bytes, (byte) =>
    byte.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  ).join(":");
}

/** A certificate date (seconds since the epoch) in the user's locale. */
export function formatCertificateDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
