/**
 * The relay's HTTP API.
 *
 * Linking follows the OAuth device authorization grant (RFC 8628): a Frigate
 * asks for a code, its admin approves the code here while signed in, and the
 * Frigate's poll then receives its credentials and tunnel token. Afterwards
 * the Frigate authenticates with its instance secret, and people manage their
 * linked instances with their Clerk session. Frigate traffic itself never
 * passes through the relay; it goes through the instance's tunnel.
 */

import {
  type AccountDirectory,
  type UserAuthenticator,
  type UserIdentity,
  authenticateInstance,
} from "./auth.ts";
import type { CloudflareApi } from "./cloudflare.ts";
import { type RelayConfig, clerkFrontendApi } from "./config.ts";
import { newInstanceId, newRequestId, newSecret, newUserCode, normalizeUserCode, sha256Hex } from "./crypto.ts";
import { HttpError, empty, errorResponse, json, readJsonObject, requireString } from "./http.ts";
import { parseOrigin } from "./origin.ts";
import { Provisioner } from "./provisioning.ts";
import { type InstanceRow, type LinkRequestRow, Store, originOf } from "./store.ts";

export const LINK_REQUEST_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_SECONDS = 5;
/** Long enough for a provisioning attempt, short enough that a dead one does not block retries. */
export const PROVISIONING_LEASE_MS = 60_000;
/** A provisioning instance this old was abandoned and is cleaned up. */
export const ABANDONED_PROVISIONING_MS = 60 * 60_000;
const MAX_NAME_LENGTH = 64;

export interface Dependencies {
  readonly config: RelayConfig;
  readonly store: Store;
  readonly cloudflare: CloudflareApi;
  readonly users: UserAuthenticator;
  readonly accounts: AccountDirectory;
  readonly linkRateLimiter?: RateLimit;
  readonly codeRateLimiter?: RateLimit;
  readonly now: () => number;
}

type Handler = (request: Request, params: Record<string, string>, deps: Dependencies) => Promise<Response>;

function cleanName(raw: string): string {
  // Names are shown on the relay's pages and in Frigate; drop control
  // characters rather than trusting every renderer to.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, MAX_NAME_LENGTH) || "Frigate";
}

function publicBase(request: Request, config: RelayConfig): string {
  return config.publicUrl ?? new URL(request.url).origin;
}

function instanceView(instance: InstanceRow) {
  return {
    instance_id: instance.id,
    name: instance.name,
    hostname: instance.hostname,
    url: `https://${instance.hostname}/`,
    account_label: instance.account_label,
  };
}

function provisioner(deps: Dependencies): Provisioner {
  return new Provisioner(deps.store, deps.cloudflare, deps.config.tunnelNamePrefix, deps.now);
}

/** Remove an instance's access at once, then its tunnel and hostname. */
async function removeInstance(instance: InstanceRow, deps: Dependencies): Promise<boolean> {
  await deps.store.markDeleting(instance.id, deps.now());
  try {
    await provisioner(deps).teardown({ ...instance, state: "deleting" });
    return true;
  } catch (error) {
    // The scheduled maintenance retries instances left in "deleting".
    console.error("instance teardown failed", { instanceId: instance.id, error: String(error) });
    return false;
  }
}

const getInfo: Handler = async (request, _params, deps) =>
  json({
    service_name: deps.config.serviceName,
    dashboard_url: `${publicBase(request, deps.config)}/`,
    clerk_publishable_key: deps.config.clerkPublishableKey,
    clerk_frontend_api: clerkFrontendApi(deps.config.clerkPublishableKey),
  });

const createLinkRequest: Handler = async (request, _params, deps) => {
  if (deps.linkRateLimiter !== undefined) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await deps.linkRateLimiter.limit({ key });
    if (!success) {
      throw new HttpError(429, "rate_limited", "Too many link requests; try again in a minute");
    }
  }
  const body = await readJsonObject(request);
  const name = cleanName(requireString(body, "name", { maxLength: 256 }));
  const origin = parseOrigin(body.origin);

  const deviceCode = newSecret();
  const userCode = newUserCode();
  const now = deps.now();
  await deps.store.insertLinkRequest({
    id: newRequestId(),
    device_code_hash: await sha256Hex(deviceCode),
    user_code: userCode,
    instance_name: name,
    origin_scheme: origin.scheme,
    origin_host: origin.host,
    origin_port: origin.port,
    status: "pending",
    user_id: null,
    account_label: null,
    instance_id: null,
    claimed_until: null,
    created_at: now,
    expires_at: now + LINK_REQUEST_TTL_MS,
  });

  const base = publicBase(request, deps.config);
  return json(
    {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${base}/link`,
      verification_uri_complete: `${base}/link?code=${encodeURIComponent(userCode)}`,
      expires_in: LINK_REQUEST_TTL_MS / 1000,
      interval: POLL_INTERVAL_SECONDS,
    },
    201,
  );
};

/**
 * The Frigate polls with its device code. Errors use RFC 8628's names so the
 * caller knows whether to keep polling.
 */
const pollLinkRequest: Handler = async (request, _params, deps) => {
  const body = await readJsonObject(request);
  const deviceCode = requireString(body, "device_code", { maxLength: 256 });
  const row = await deps.store.findLinkRequestByDeviceCodeHash(await sha256Hex(deviceCode));
  if (row === null) {
    throw new HttpError(400, "invalid_grant", "Unknown link request");
  }
  const now = deps.now();
  if (row.status === "denied") {
    await deps.store.deleteLinkRequest(row.id);
    throw new HttpError(400, "access_denied", "The link request was declined");
  }
  if (now >= row.expires_at) {
    throw new HttpError(400, "expired_token", "The link request expired");
  }
  if (row.status === "pending") {
    throw new HttpError(400, "authorization_pending", "Waiting for approval");
  }
  if (!(await deps.store.claimLinkRequest(row.id, now, PROVISIONING_LEASE_MS))) {
    // Another poll for the same request is provisioning right now.
    throw new HttpError(400, "slow_down", "Still setting up");
  }

  try {
    return json(await completeLink(row, deps));
  } catch (error) {
    await deps.store.releaseLinkRequest(row.id);
    if (error instanceof HttpError) {
      throw error;
    }
    console.error("link provisioning failed", { linkRequestId: row.id, error: String(error) });
    throw new HttpError(502, "provisioning_failed", "Could not set up the tunnel yet; keep polling to retry");
  }
};

async function completeLink(row: LinkRequestRow, deps: Dependencies) {
  let instance = row.instance_id === null ? null : await deps.store.getInstance(row.instance_id);
  if (instance === null) {
    if (row.status === "completed") {
      // Removed from the account before this Frigate collected it.
      throw new HttpError(400, "access_denied", "The instance was removed from the account");
    }
    const id = newInstanceId();
    const now = deps.now();
    instance = {
      id,
      user_id: row.user_id!,
      account_label: row.account_label,
      name: row.instance_name,
      hostname: `${id}.${deps.config.tunnelZoneName}`,
      secret_hash: null,
      origin_scheme: row.origin_scheme,
      origin_host: row.origin_host,
      origin_port: row.origin_port,
      tunnel_id: null,
      dns_record_id: null,
      configured_origin: null,
      state: "provisioning",
      created_at: now,
      updated_at: now,
      last_sync_at: null,
    };
    await deps.store.createInstanceForLinkRequest(row.id, instance);
  }
  if (instance.state === "deleting") {
    throw new HttpError(400, "access_denied", "The instance was removed from the account");
  }

  const { instance: ready } = await provisioner(deps).ensureEndpoint(instance, originOf(row));
  const tunnelToken = await deps.cloudflare.getTunnelToken(ready.tunnel_id!);
  // A repeated poll, after a response that never arrived, issues a fresh
  // secret; only the holder of the device code can ask for one.
  const secret = newSecret();
  if (!(await deps.store.activateInstance(ready.id, await sha256Hex(secret), deps.now()))) {
    throw new HttpError(400, "access_denied", "The instance was removed from the account");
  }
  await deps.store.completeLinkRequest(row.id);
  return {
    ...instanceView(ready),
    instance_secret: `${ready.id}.${secret}`,
    tunnel_token: tunnelToken,
  };
}

async function findDecidableLinkRequest(
  identity: UserIdentity,
  params: Record<string, string>,
  deps: Dependencies,
) {
  if (deps.codeRateLimiter !== undefined) {
    const { success } = await deps.codeRateLimiter.limit({ key: identity.userId });
    if (!success) {
      throw new HttpError(429, "rate_limited", "Too many attempts; try again in a minute");
    }
  }
  const userCode = normalizeUserCode(params.code ?? "");
  const row = userCode === null ? null : await deps.store.findLinkRequestByUserCode(userCode);
  if (row === null || deps.now() >= row.expires_at) {
    throw new HttpError(404, "unknown_code", "No link request has this code, or it expired");
  }
  return row;
}

const getLinkRequest: Handler = async (request, params, deps) => {
  const identity = await deps.users.authenticate(request);
  const row = await findDecidableLinkRequest(identity, params, deps);
  return json({
    user_code: row.user_code,
    name: row.instance_name,
    status: row.status === "completed" ? "approved" : row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
  });
};

const approveLinkRequest: Handler = async (request, params, deps) => {
  const identity = await deps.users.authenticate(request);
  const row = await findDecidableLinkRequest(identity, params, deps);
  if (row.status !== "pending") {
    throw new HttpError(409, "already_decided", "This code was already used");
  }
  const count = await deps.store.countInstancesForUser(identity.userId);
  if (count >= deps.config.maxInstancesPerUser) {
    throw new HttpError(
      409,
      "instance_limit_reached",
      `Your account can link up to ${deps.config.maxInstancesPerUser} Frigate servers; remove one first`,
    );
  }
  let accountLabel: string | null = null;
  try {
    accountLabel = await deps.accounts.labelFor(identity.userId);
  } catch (error) {
    // Only a display label; linking works without it.
    console.warn("account label lookup failed", { error: String(error) });
  }
  const decided = await deps.store.decideLinkRequest(
    row.id,
    { status: "approved", userId: identity.userId, accountLabel },
    deps.now(),
  );
  if (!decided) {
    throw new HttpError(409, "already_decided", "This code was already used");
  }
  return json({ status: "approved" });
};

const denyLinkRequest: Handler = async (request, params, deps) => {
  const identity = await deps.users.authenticate(request);
  const row = await findDecidableLinkRequest(identity, params, deps);
  if (!(await deps.store.decideLinkRequest(row.id, { status: "denied" }, deps.now()))) {
    throw new HttpError(409, "already_decided", "This code was already used");
  }
  return json({ status: "denied" });
};

const getInstance: Handler = async (request, _params, deps) => {
  const instance = await authenticateInstance(request, deps.store);
  return json(instanceView(instance));
};

/**
 * Called by the Frigate when it starts and when its connector keeps failing:
 * repairs the tunnel, follows a changed local origin, and hands out a new
 * token when the tunnel had to be replaced or the Frigate asks for one.
 */
const syncInstance: Handler = async (request, _params, deps) => {
  const instance = await authenticateInstance(request, deps.store);
  const body = await readJsonObject(request);
  const origin = parseOrigin(body.origin);
  const name = typeof body.name === "string" ? cleanName(body.name) : instance.name;
  const includeToken = body.include_token === true;

  let ensured;
  let tunnelToken: string | null = null;
  try {
    ensured = await provisioner(deps).ensureEndpoint(instance, origin);
    if (includeToken || ensured.tunnelChanged) {
      tunnelToken = await deps.cloudflare.getTunnelToken(ensured.instance.tunnel_id!);
    }
  } catch (error) {
    console.error("instance sync failed", { instanceId: instance.id, error: String(error) });
    throw new HttpError(502, "provisioning_failed", "Could not update the tunnel; try again later");
  }
  await deps.store.recordSync(instance.id, name, deps.now());
  return json({
    ...instanceView({ ...ensured.instance, name }),
    tunnel_token: tunnelToken,
    tunnel_replaced: ensured.tunnelChanged,
  });
};

const unlinkInstance: Handler = async (request, _params, deps) => {
  const instance = await authenticateInstance(request, deps.store);
  const removed = await removeInstance(instance, deps);
  return removed ? empty(204) : json({ status: "removing" }, 202);
};

function presence(instance: InstanceRow, tunnelStatus: string | null | undefined): string {
  if (instance.state === "deleting") {
    return "removing";
  }
  if (instance.state === "provisioning") {
    return "setting_up";
  }
  if (tunnelStatus === undefined) {
    return "unknown";
  }
  return tunnelStatus === "healthy" || tunnelStatus === "degraded" ? "online" : "offline";
}

const listMyInstances: Handler = async (request, _params, deps) => {
  const identity = await deps.users.authenticate(request);
  const instances = await deps.store.listInstancesForUser(identity.userId);
  const tunnels = await Promise.allSettled(
    instances.map((instance) =>
      instance.tunnel_id === null ? Promise.resolve(null) : deps.cloudflare.getTunnel(instance.tunnel_id),
    ),
  );
  return json({
    instances: instances.map((instance, index) => {
      const tunnel = tunnels[index]!;
      return {
        ...instanceView(instance),
        created_at: instance.created_at,
        last_sync_at: instance.last_sync_at,
        status: presence(instance, tunnel.status === "fulfilled" ? (tunnel.value?.status ?? null) : undefined),
      };
    }),
  });
};

const removeMyInstance: Handler = async (request, params, deps) => {
  const identity = await deps.users.authenticate(request);
  const instance = await deps.store.getInstance(params.id ?? "");
  if (instance === null || instance.user_id !== identity.userId) {
    throw new HttpError(404, "unknown_instance", "No such Frigate on your account");
  }
  if (instance.state === "deleting") {
    return json({ status: "removing" }, 202);
  }
  const removed = await removeInstance(instance, deps);
  return removed ? empty(204) : json({ status: "removing" }, 202);
};

const routes: ReadonlyArray<{ method: string; pattern: URLPattern; handler: Handler }> = [
  ["GET", "/v1/info", getInfo],
  ["POST", "/v1/link-requests", createLinkRequest],
  ["POST", "/v1/link-requests/token", pollLinkRequest],
  ["GET", "/v1/link-requests/:code", getLinkRequest],
  ["POST", "/v1/link-requests/:code/approve", approveLinkRequest],
  ["POST", "/v1/link-requests/:code/deny", denyLinkRequest],
  ["GET", "/v1/instance", getInstance],
  ["POST", "/v1/instance/sync", syncInstance],
  ["DELETE", "/v1/instance", unlinkInstance],
  ["GET", "/v1/me/instances", listMyInstances],
  ["DELETE", "/v1/me/instances/:id", removeMyInstance],
].map(([method, pathname, handler]) => ({
  method: method as string,
  pattern: new URLPattern({ pathname: pathname as string }),
  handler: handler as Handler,
}));

export async function handleApiRequest(request: Request, deps: Dependencies): Promise<Response> {
  const url = new URL(request.url);
  let pathMatched = false;
  for (const route of routes) {
    const match = route.pattern.exec({ pathname: url.pathname });
    if (match === null) {
      continue;
    }
    pathMatched = true;
    if (route.method !== request.method) {
      continue;
    }
    const params = Object.fromEntries(
      Object.entries(match.pathname.groups).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    );
    try {
      return await route.handler(request, params, deps);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error);
      }
      console.error("unhandled relay error", { path: url.pathname, error: String(error) });
      return errorResponse(new HttpError(500, "internal_error", "Something went wrong"));
    }
  }
  return pathMatched
    ? errorResponse(new HttpError(405, "method_not_allowed"))
    : errorResponse(new HttpError(404, "not_found"));
}

/** Expire link requests and finish teardowns that failed part way. */
export async function runMaintenance(deps: Dependencies): Promise<void> {
  const now = deps.now();
  const abandoned = await deps.store.listInstancesInState("provisioning", now - ABANDONED_PROVISIONING_MS, 50);
  for (const instance of abandoned) {
    await deps.store.markDeleting(instance.id, now);
  }
  const deleting = await deps.store.listInstancesInState("deleting", now, 50);
  for (const instance of deleting) {
    try {
      await provisioner(deps).teardown(instance);
    } catch (error) {
      console.error("scheduled teardown failed", { instanceId: instance.id, error: String(error) });
    }
  }
  // Keep finished requests until well after expiry so a late poll still gets
  // a meaningful error rather than an unknown code.
  await deps.store.deleteLinkRequestsExpiredBefore(now - 60 * 60_000);
}
