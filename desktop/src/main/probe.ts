/** Checking that an address is a Frigate server before saving it. */

import { randomUUID } from "node:crypto";

import { net, session } from "electron";

import type { CertificateInfo } from "../shared/types";
import {
  ACCEPT_CERTIFICATE,
  toCertificateInfo,
  verifyCertificate,
} from "./certificates";
import { bareHostname } from "./serverUrl";

const PROBE_TIMEOUT_MS = 10_000;
/** The answers are tiny JSON objects; anything bigger isn't Frigate. */
const MAX_BODY_BYTES = 64 * 1024;
/** Frigate serves this without sign-in on every port, for its login page. */
const LOGIN_INFO_PATH = "api/auth/first_time_login";

export type ProbeResult =
  | { kind: "ok"; loginRequired: boolean; pinnedFingerprint: string | null }
  | { kind: "rejected"; reason: "internal_port" | "not_frigate" }
  | { kind: "redirected"; address: string }
  | { kind: "unreachable"; error: string }
  | { kind: "untrusted_certificate"; certificate: CertificateInfo };

type ProfileResult =
  | { kind: "ok"; loginRequired: boolean }
  | { kind: "rejected"; reason: "internal_port" | "not_frigate" };

/** True for Frigate's answer to GET api/auth/first_time_login. */
export function isFrigateLoginInfo(status: number, body: unknown): boolean {
  return (
    status === 200 &&
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).admin_first_time_login ===
      "boolean"
  );
}

/** Interpret GET api/profile made without signing in. */
export function interpretProfile(status: number, body: unknown): ProfileResult {
  if (status === 401) {
    return { kind: "ok", loginRequired: true };
  }

  if (status === 200 && typeof body === "object" && body !== null) {
    const { username, role } = body as Record<string, unknown>;

    // The internal port answers every request as an anonymous admin, even on
    // a port number other than 5000.
    if (username === "anonymous" && role === "admin") {
      return { kind: "rejected", reason: "internal_port" };
    }

    // With auth off, Frigate lets everyone in as "viewer" or the proxy's user.
    if (typeof username === "string") {
      return { kind: "ok", loginRequired: false };
    }
  }

  return { kind: "rejected", reason: "not_frigate" };
}

/**
 * Ask the server, as a signed-out visitor, whether it's Frigate and whether
 * it requires sign-in.
 *
 * Runs in a throwaway in-memory session, so no cookies are sent and nothing
 * is kept. When the system doesn't trust the certificate, the certificate is
 * returned for the user to decide on, unless it's the one in
 * `trustedFingerprint`.
 */
export async function probeServer(
  url: string,
  hostname: string,
  trustedFingerprint: string | null,
): Promise<ProbeResult> {
  const probeSession = session.fromPartition(`probe-${randomUUID()}`);
  let rejectedCertificate: CertificateInfo | null = null;
  let pinUsed = false;

  probeSession.setCertificateVerifyProc((request, callback) => {
    const result = verifyCertificate(request, hostname, trustedFingerprint);

    if (result === ACCEPT_CERTIFICATE) {
      pinUsed = true;
    } else if (
      request.errorCode !== 0 &&
      bareHostname(request.hostname) === hostname
    ) {
      rejectedCertificate = toCertificateInfo(request.certificate);
    }

    callback(result);
  });

  const loginInfo = await get(probeSession, url, LOGIN_INFO_PATH);

  if ("error" in loginInfo) {
    return rejectedCertificate
      ? { kind: "untrusted_certificate", certificate: rejectedCertificate }
      : { kind: "unreachable", error: loginInfo.error };
  }

  if ("address" in loginInfo) {
    return loginInfo.address
      ? { kind: "redirected", address: loginInfo.address }
      : { kind: "rejected", reason: "not_frigate" };
  }

  if (!isFrigateLoginInfo(loginInfo.status, loginInfo.body)) {
    return { kind: "rejected", reason: "not_frigate" };
  }

  const profile = await get(probeSession, url, "api/profile");

  if ("error" in profile) {
    return { kind: "unreachable", error: profile.error };
  }

  if ("address" in profile) {
    return { kind: "rejected", reason: "not_frigate" };
  }

  const result = interpretProfile(profile.status, profile.body);

  if (result.kind === "rejected") {
    return result;
  }

  return { ...result, pinnedFingerprint: pinUsed ? trustedFingerprint : null };
}

type GetResult =
  | { status: number; body: unknown }
  /** A redirect, with the address to suggest instead, or null if none fits. */
  | { address: string | null }
  | { error: string };

/**
 * GET a path under the server's base URL without following redirects.
 * Electron's fetch follows them without saying where it ended up, which would
 * save an address that isn't the one serving Frigate.
 */
function get(
  probeSession: Electron.Session,
  baseUrl: string,
  path: string,
): Promise<GetResult> {
  const target = `${baseUrl}${path}`;

  return new Promise((resolve) => {
    const request = net.request({
      url: target,
      session: probeSession,
      redirect: "manual",
    });
    const timeout = setTimeout(() => {
      request.abort();
      resolve({ error: "timed out" });
    }, PROBE_TIMEOUT_MS);
    const finish = (result: GetResult) => {
      clearTimeout(timeout);
      resolve(result);
    };

    request.on("redirect", (_status, _method, location) => {
      request.abort();
      finish({ address: redirectSuggestion(target, location, path, baseUrl) });
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;

      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          request.abort();
          finish({ status: response.statusCode, body: null });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        finish({
          status: response.statusCode,
          body: parseJson(Buffer.concat(chunks)),
        });
      });
      response.on("error", (error: Error) => finish({ error: error.message }));
    });
    request.on("error", (error) => finish({ error: error.message }));
    request.end();
  });
}

/**
 * The base address a redirect points to, e.g. the https:// version of an
 * http:// address. Null when it leads somewhere else on the same server or
 * to a page that isn't the same API path, such as a proxy's sign-in page.
 */
export function redirectSuggestion(
  requestUrl: string,
  location: string,
  path: string,
  baseUrl: string,
): string | null {
  let resolved: URL;

  try {
    resolved = new URL(location, requestUrl);
  } catch {
    return null;
  }

  resolved.search = "";
  resolved.hash = "";
  const address = resolved.toString();

  if (!address.endsWith(`/${path}`)) {
    return null;
  }

  const suggestion = address.slice(0, -path.length);

  return suggestion === baseUrl ? null : suggestion;
}

function parseJson(data: Buffer): unknown {
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
}
