/** Parsing of the server addresses users type in. */

/** Frigate's authenticated port. */
export const DEFAULT_PORT = 8971;

/**
 * Frigate's internal port. Every request on it is treated as an admin, so the
 * app refuses it. The port can be changed in Frigate's config, which is why
 * adding a server also asks the server who it thinks we are.
 */
export const INTERNAL_PORT = 5000;

export type ParsedServerUrl =
  | { ok: true; url: string; origin: string; hostname: string }
  | {
      ok: false;
      reason: "invalid_url" | "unsupported_scheme" | "internal_port";
    };

/**
 * Turn what the user typed into a normalized base URL.
 *
 * A bare host gets https and port 8971, since that is how a stock Frigate
 * install is reached. An address with a scheme keeps its port, so servers
 * behind a reverse proxy on 443 work as typed.
 */
export function parseServerUrl(input: string): ParsedServerUrl {
  const trimmed = input.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);

  if (!trimmed) {
    return { ok: false, reason: "invalid_url" };
  }

  let url: URL;

  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "unsupported_scheme" };
  }

  // Credentials in the URL would be sent on every request and saved in
  // servers.json; Frigate's own sign-in page is the way in.
  if (!url.hostname || url.username || url.password) {
    return { ok: false, reason: "invalid_url" };
  }

  if (!hasScheme && url.port === "") {
    url.port = String(DEFAULT_PORT);
  }

  if (url.port === String(INTERNAL_PORT)) {
    return { ok: false, reason: "internal_port" };
  }

  url.search = "";
  url.hash = "";

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return {
    ok: true,
    url: url.toString(),
    origin: url.origin,
    hostname: bareHostname(url.hostname),
  };
}

/** A URL's hostname without the brackets URL adds around IPv6 addresses. */
export function bareHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1");
}

/** True when `candidate` is on the same origin as the server's base URL. */
export function isSameOrigin(candidate: string, serverUrl: string): boolean {
  try {
    return new URL(candidate).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** True for links it's reasonable to hand to the system browser. */
export function isExternalLink(candidate: string): boolean {
  try {
    const { protocol } = new URL(candidate);
    return (
      protocol === "https:" || protocol === "http:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}
