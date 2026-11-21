/** The local address a Frigate asks its tunnel to forward to. */

import { HttpError } from "./http.ts";

export interface Origin {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
}

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255 && String(Number(part)) === part)
  );
}

function isIpv6(host: string): boolean {
  if (!/^[0-9a-f:.]+$/iu.test(host) || !host.includes(":")) {
    return false;
  }
  try {
    return new URL(`http://[${host}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/**
 * Only IP literals: the origin is an address inside the Frigate's own host,
 * so there is no name to resolve, and a hostname would let the relay's
 * configuration depend on DNS the relay cannot see.
 */
export function parseOrigin(value: unknown): Origin {
  if (typeof value !== "object" || value === null) {
    throw new HttpError(400, "invalid_origin", "origin must be an object");
  }
  const { scheme, host, port } = value as Record<string, unknown>;
  if (scheme !== "http" && scheme !== "https") {
    throw new HttpError(400, "invalid_origin", "origin.scheme must be http or https");
  }
  if (typeof host !== "string" || !(isIpv4(host) || isIpv6(host))) {
    throw new HttpError(400, "invalid_origin", "origin.host must be an IP address");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, "invalid_origin", "origin.port must be a port number");
  }
  return { scheme, host: host.toLowerCase(), port };
}

/** The cloudflared ingress service for the origin, such as `https://127.0.0.1:8971`. */
export function originService(origin: Origin): string {
  const host = origin.host.includes(":") ? `[${origin.host}]` : origin.host;
  return `${origin.scheme}://${host}:${origin.port}`;
}
