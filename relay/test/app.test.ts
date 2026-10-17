import { describe, expect, it } from "vitest";

import { LINK_REQUEST_TTL_MS, PROVISIONING_LEASE_MS, handleApiRequest, runMaintenance } from "../src/app.ts";
import { CloudflareApiError } from "../src/cloudflare.ts";
import { type Harness, harness } from "./fakes.ts";

const ORIGIN = { scheme: "https", host: "127.0.0.1", port: 8971 };

async function call(
  h: Harness,
  method: string,
  path: string,
  options: { body?: unknown; auth?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.auth !== undefined) {
    headers.authorization = `Bearer ${options.auth}`;
  }
  const response = await handleApiRequest(
    new Request(`https://relay.example.com${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    h.deps,
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function startLink(h: Harness, name = "Garage") {
  const response = await call(h, "POST", "/v1/link-requests", { body: { name, origin: ORIGIN } });
  expect(response.status).toBe(201);
  return response.body as { device_code: string; user_code: string; verification_uri_complete: string };
}

function poll(h: Harness, deviceCode: string) {
  return call(h, "POST", "/v1/link-requests/token", { body: { device_code: deviceCode } });
}

async function linkInstance(h: Harness, user = "alice") {
  const link = await startLink(h);
  expect((await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: `user:${user}` })).status).toBe(
    200,
  );
  const completed = await poll(h, link.device_code);
  expect(completed.status).toBe(200);
  return completed.body as {
    instance_id: string;
    instance_secret: string;
    hostname: string;
    url: string;
    tunnel_token: string;
    account_label: string;
  };
}

describe("linking", () => {
  it("links a Frigate once its code is approved", async () => {
    const h = harness();
    const link = await startLink(h);
    expect(link.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
    expect(link.verification_uri_complete).toBe(`https://relay.example.com/link?code=${link.user_code}`);

    expect((await poll(h, link.device_code)).body.error).toBe("authorization_pending");

    const details = await call(h, "GET", `/v1/link-requests/${link.user_code.toLowerCase()}`, { auth: "user:alice" });
    expect(details.body).toMatchObject({ name: "Garage", status: "pending", user_code: link.user_code });

    expect((await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" })).status).toBe(
      200,
    );
    const completed = await poll(h, link.device_code);
    expect(completed.status).toBe(200);

    const { instance_id: id, hostname, url, tunnel_token: token, account_label: label } = completed.body;
    expect(hostname).toBe(`${id}.tunnels.example.net`);
    expect(url).toBe(`https://${hostname}/`);
    expect(label).toBe("alice@example.com");

    const [tunnel] = h.cloudflare.liveTunnels();
    expect(tunnel?.name).toBe(`test-${id}`);
    expect(token).toBe(tunnel?.token);
    expect(tunnel?.ingress).toEqual([
      { hostname, service: "https://127.0.0.1:8971", originRequest: { noTLSVerify: true } },
      { service: "http_status:404" },
    ]);
    expect([...h.cloudflare.records.values()]).toEqual([
      expect.objectContaining({ name: hostname, content: `${tunnel?.id}.cfargotunnel.com` }),
    ]);

    const me = await call(h, "GET", "/v1/instance", { auth: completed.body.instance_secret });
    expect(me.body).toMatchObject({ instance_id: id, name: "Garage", hostname });
  });

  it("tells the Frigate when its request is declined", async () => {
    const h = harness();
    const link = await startLink(h);
    expect((await call(h, "POST", `/v1/link-requests/${link.user_code}/deny`, { auth: "user:alice" })).status).toBe(
      200,
    );
    expect((await poll(h, link.device_code)).body.error).toBe("access_denied");
    expect((await poll(h, link.device_code)).body.error).toBe("invalid_grant");
    expect(h.cloudflare.calls).toEqual([]);
  });

  it("expires codes nobody approves", async () => {
    const h = harness();
    const link = await startLink(h);
    h.advance(LINK_REQUEST_TTL_MS);
    expect((await poll(h, link.device_code)).body.error).toBe("expired_token");
    const approval = await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    expect(approval).toMatchObject({ status: 404, body: { error: "unknown_code" } });
  });

  it("requires a signed-in account to see or decide a code", async () => {
    const h = harness();
    const link = await startLink(h);
    expect((await call(h, "GET", `/v1/link-requests/${link.user_code}`)).status).toBe(401);
    expect((await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`)).status).toBe(401);
    expect((await poll(h, link.device_code)).body.error).toBe("authorization_pending");
  });

  it("does not let a code be decided twice", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    const second = await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:mallory" });
    expect(second).toMatchObject({ status: 409, body: { error: "already_decided" } });
    const denial = await call(h, "POST", `/v1/link-requests/${link.user_code}/deny`, { auth: "user:mallory" });
    expect(denial.status).toBe(409);
    expect((await poll(h, link.device_code)).status).toBe(200);
  });

  it("counts approved codes against the limit before they are collected", async () => {
    const h = harness();
    const links = [await startLink(h), await startLink(h), await startLink(h)];
    const approvals = [];
    for (const link of links) {
      approvals.push((await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" })).body);
    }
    expect(approvals).toEqual([
      { status: "approved" },
      { status: "approved" },
      expect.objectContaining({ error: "instance_limit_reached" }),
    ]);
    expect((await poll(h, links[2]!.device_code)).body.error).toBe("authorization_pending");
  });

  it("creates one instance when two polls collect the same approval", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    const results = await Promise.all([poll(h, link.device_code), poll(h, link.device_code)]);
    const succeeded = results.filter((result) => result.status === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(new Set(succeeded.map((result) => result.body.instance_id)).size).toBe(1);
    for (const result of results.filter((result) => result.status !== 200)) {
      expect(result.body.error).toBe("slow_down");
    }
    // A poll that read the request before the other created the instance.
    const retry = await poll(h, link.device_code);
    expect(retry.body.instance_id).toBe(succeeded[0]!.body.instance_id);
    expect(h.cloudflare.liveTunnels()).toHaveLength(1);
    expect((await call(h, "GET", "/v1/me/instances", { auth: "user:alice" })).body.instances).toHaveLength(1);
  });

  it("keeps the first instance assigned to a request", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    const row = (await h.store.findLinkRequestByUserCode(link.user_code))!;
    const candidate = (id: string) => ({
      id,
      user_id: "alice",
      account_label: null,
      name: "Garage",
      hostname: `${id}.tunnels.example.net`,
      secret_hash: null,
      origin_scheme: "https" as const,
      origin_host: "127.0.0.1",
      origin_port: 8971,
      tunnel_id: null,
      dns_record_id: null,
      dns_target: null,
      configured_origin: null,
      state: "provisioning" as const,
      busy_until: null,
      created_at: 1,
      updated_at: 1,
      last_sync_at: null,
    });
    expect(await h.store.createInstanceForLinkRequest(row.id, candidate("first"))).toBe("first");
    expect(await h.store.createInstanceForLinkRequest(row.id, candidate("second"))).toBe("first");
    expect(await h.store.getInstance("second")).toBeNull();
  });

  it("stops at the per-account limit", async () => {
    const h = harness();
    await linkInstance(h);
    await linkInstance(h);
    const link = await startLink(h);
    const approval = await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    expect(approval).toMatchObject({ status: 409, body: { error: "instance_limit_reached" } });
  });

  it("resumes provisioning after a failure without creating a second tunnel", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });

    h.cloudflare.failNext("createProxiedCname");
    expect(await poll(h, link.device_code)).toMatchObject({ status: 502, body: { error: "provisioning_failed" } });
    expect(h.cloudflare.liveTunnels()).toHaveLength(1);

    const completed = await poll(h, link.device_code);
    expect(completed.status).toBe(200);
    expect(h.cloudflare.liveTunnels()).toHaveLength(1);
    expect(h.cloudflare.records.size).toBe(1);
  });

  it("adopts a tunnel whose creation response was lost", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });

    // The tunnel is created, then the token request fails before anything is recorded.
    h.cloudflare.failNext("getTunnelToken");
    expect((await poll(h, link.device_code)).status).toBe(502);
    expect((await poll(h, link.device_code)).status).toBe(200);
    expect(h.cloudflare.liveTunnels()).toHaveLength(1);
  });

  it("answers a concurrent poll with slow_down while one is provisioning", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    const row = await h.store.findLinkRequestByUserCode(link.user_code);
    expect(await h.store.claimLinkRequest(row!.id, h.deps.now(), PROVISIONING_LEASE_MS)).toBe(true);

    expect((await poll(h, link.device_code)).body.error).toBe("slow_down");
    h.advance(PROVISIONING_LEASE_MS);
    expect((await poll(h, link.device_code)).status).toBe(200);
  });

  it("issues a new secret when the Frigate polls again after a lost response", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    const first = await poll(h, link.device_code);
    const second = await poll(h, link.device_code);

    expect(second.body.instance_id).toBe(first.body.instance_id);
    expect(second.body.tunnel_token).toBe(first.body.tunnel_token);
    expect(second.body.instance_secret).not.toBe(first.body.instance_secret);
    expect((await call(h, "GET", "/v1/instance", { auth: first.body.instance_secret })).status).toBe(401);
    expect((await call(h, "GET", "/v1/instance", { auth: second.body.instance_secret })).status).toBe(200);
  });

  it("rate-limits new link requests", async () => {
    const h = harness({ linkRateLimiter: { limit: async () => ({ success: false }) } });
    const response = await call(h, "POST", "/v1/link-requests", { body: { name: "Garage", origin: ORIGIN } });
    expect(response).toMatchObject({ status: 429, body: { error: "rate_limited" } });
  });

  it("rate-limits code lookups per account", async () => {
    const keys: string[] = [];
    const h = harness({
      codeRateLimiter: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: keys.length < 2 };
        },
      },
    });
    const link = await startLink(h);
    expect((await call(h, "GET", `/v1/link-requests/${link.user_code}`, { auth: "user:alice" })).status).toBe(200);
    const limited = await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    expect(limited).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(keys).toEqual(["alice", "alice"]);
  });

  it.each([
    [{ ...ORIGIN, host: "localhost" }],
    [{ ...ORIGIN, host: "frigate.example.com" }],
    [{ ...ORIGIN, scheme: "ftp" }],
    [{ ...ORIGIN, port: 0 }],
    [{ ...ORIGIN, port: 70000 }],
    [undefined],
  ])("rejects origin %j", async (origin) => {
    const h = harness();
    const response = await call(h, "POST", "/v1/link-requests", { body: { name: "Garage", origin } });
    expect(response.status).toBe(400);
  });

  it("accepts an IPv6 origin and brackets it for cloudflared", async () => {
    const h = harness();
    const link = await call(h, "POST", "/v1/link-requests", {
      body: { name: "Garage", origin: { scheme: "http", host: "::1", port: 8971 } },
    });
    await call(h, "POST", `/v1/link-requests/${link.body.user_code}/approve`, { auth: "user:alice" });
    await poll(h, link.body.device_code);
    expect(h.cloudflare.liveTunnels()[0]?.ingress?.[0]).toEqual({
      hostname: expect.any(String),
      service: "http://[::1]:8971",
    });
  });

  it("strips control characters from names", async () => {
    const h = harness();
    const link = await startLink(h, "Gar\u0000age\n");
    const details = await call(h, "GET", `/v1/link-requests/${link.user_code}`, { auth: "user:alice" });
    expect(details.body.name).toBe("Garage");
  });
});

describe("a linked instance", () => {
  it("rejects credentials it did not issue", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    for (const auth of [undefined, "nonsense", `${linked.instance_id}.wrong`, `other.${linked.instance_secret}`]) {
      expect((await call(h, "GET", "/v1/instance", { ...(auth ? { auth } : {}) })).status).toBe(401);
    }
  });

  it("syncs without touching Cloudflare more than needed", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    h.cloudflare.calls.length = 0;

    const synced = await call(h, "POST", "/v1/instance/sync", {
      auth: linked.instance_secret,
      body: { origin: ORIGIN, name: "Driveway" },
    });
    expect(synced.body).toMatchObject({ name: "Driveway", tunnel_token: null, tunnel_replaced: false });
    expect(h.cloudflare.calls).toEqual(["getTunnel"]);

    const withToken = await call(h, "POST", "/v1/instance/sync", {
      auth: linked.instance_secret,
      body: { origin: ORIGIN, include_token: true },
    });
    expect(withToken.body).toMatchObject({ name: "Driveway", tunnel_token: linked.tunnel_token });
  });

  it("follows a changed origin", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    await call(h, "POST", "/v1/instance/sync", {
      auth: linked.instance_secret,
      body: { origin: { scheme: "http", host: "127.0.0.1", port: 8972 } },
    });
    expect(h.cloudflare.liveTunnels()[0]?.ingress?.[0]).toEqual({
      hostname: linked.hostname,
      service: "http://127.0.0.1:8972",
    });
  });

  it("replaces a tunnel deleted outside the relay and keeps its hostname", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    const [original] = h.cloudflare.liveTunnels();
    await h.cloudflare.deleteTunnel(original!.id);

    const synced = await call(h, "POST", "/v1/instance/sync", { auth: linked.instance_secret, body: { origin: ORIGIN } });
    const [replacement] = h.cloudflare.liveTunnels();
    expect(replacement?.id).not.toBe(original?.id);
    expect(synced.body).toMatchObject({
      hostname: linked.hostname,
      tunnel_replaced: true,
      tunnel_token: replacement?.token,
    });
    expect(replacement?.ingress?.[0]).toMatchObject({ hostname: linked.hostname });
    expect([...h.cloudflare.records.values()]).toEqual([
      expect.objectContaining({ name: linked.hostname, content: `${replacement?.id}.cfargotunnel.com` }),
    ]);
  });

  it("repoints the hostname on the retry after a replacement failed part way", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    const [original] = h.cloudflare.liveTunnels();
    await h.cloudflare.deleteTunnel(original!.id);

    h.cloudflare.failNext("updateDnsRecordTarget");
    const failed = await call(h, "POST", "/v1/instance/sync", { auth: linked.instance_secret, body: { origin: ORIGIN } });
    expect(failed.status).toBe(502);

    const retried = await call(h, "POST", "/v1/instance/sync", { auth: linked.instance_secret, body: { origin: ORIGIN } });
    const [replacement] = h.cloudflare.liveTunnels();
    expect(retried.body).toMatchObject({ tunnel_replaced: true, tunnel_token: replacement?.token });
    expect([...h.cloudflare.records.values()]).toEqual([
      expect.objectContaining({ name: linked.hostname, content: `${replacement?.id}.cfargotunnel.com` }),
    ]);
  });

  it("finishes removal after a setup that was in flight", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    const [original] = h.cloudflare.liveTunnels();
    await h.cloudflare.deleteTunnel(original!.id);

    let removal: Awaited<ReturnType<typeof call>> | undefined;
    h.cloudflare.onCreateTunnel = async () => {
      removal = await call(h, "DELETE", `/v1/me/instances/${linked.instance_id}`, { auth: "user:alice" });
    };
    await call(h, "POST", "/v1/instance/sync", { auth: linked.instance_secret, body: { origin: ORIGIN } });
    // The sync held the lease, so removal revoked access and left the rest.
    expect(removal).toMatchObject({ status: 202, body: { status: "removing" } });
    expect((await call(h, "GET", "/v1/instance", { auth: linked.instance_secret })).status).toBe(401);

    h.advance(1);
    await runMaintenance(h.deps);
    expect(h.cloudflare.liveTunnels()).toEqual([]);
    expect(h.cloudflare.records.size).toBe(0);
    expect(await h.store.getInstance(linked.instance_id)).toBeNull();
  });

  it("removes resources an interrupted attempt created but never recorded", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    const stray = await h.cloudflare.createTunnel(`test-${linked.instance_id}-unused`);
    await h.cloudflare.deleteTunnel(h.cloudflare.liveTunnels()[0]!.id);
    // Same name as the instance's tunnel, as a crashed replacement leaves it.
    h.cloudflare.tunnels.get(stray.id)!.name = `test-${linked.instance_id}`;

    expect((await call(h, "DELETE", "/v1/instance", { auth: linked.instance_secret })).status).toBe(204);
    expect(h.cloudflare.liveTunnels()).toEqual([]);
  });

  it("reports a Cloudflare failure during sync as retryable", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    h.cloudflare.failNext("getTunnel");
    const synced = await call(h, "POST", "/v1/instance/sync", { auth: linked.instance_secret, body: { origin: ORIGIN } });
    expect(synced).toMatchObject({ status: 502, body: { error: "provisioning_failed" } });
  });

  it("unlinks itself and removes its tunnel and hostname", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    expect((await call(h, "DELETE", "/v1/instance", { auth: linked.instance_secret })).status).toBe(204);
    expect(h.cloudflare.liveTunnels()).toEqual([]);
    expect(h.cloudflare.records.size).toBe(0);
    expect(await h.store.getInstance(linked.instance_id)).toBeNull();
    expect((await call(h, "GET", "/v1/instance", { auth: linked.instance_secret })).status).toBe(401);
  });
});

describe("an account", () => {
  it("lists only its own instances with their tunnel status", async () => {
    const h = harness();
    const garage = await linkInstance(h, "alice");
    await linkInstance(h, "bob");
    const [tunnel] = h.cloudflare.liveTunnels();
    tunnel!.status = "healthy";

    const list = await call(h, "GET", "/v1/me/instances", { auth: "user:alice" });
    expect(list.body.instances).toEqual([
      expect.objectContaining({ instance_id: garage.instance_id, name: "Garage", status: "online" }),
    ]);
    expect((await call(h, "GET", "/v1/me/instances")).status).toBe(401);
  });

  it("shows status as unavailable when Cloudflare cannot be reached", async () => {
    const h = harness();
    await linkInstance(h);
    h.cloudflare.failNext("getTunnel");
    const list = await call(h, "GET", "/v1/me/instances", { auth: "user:alice" });
    expect(list.body.instances[0].status).toBe("unknown");
  });

  it("removes an instance, which revokes the Frigate's credentials", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    const path = `/v1/me/instances/${linked.instance_id}`;
    expect((await call(h, "DELETE", path, { auth: "user:mallory" })).status).toBe(404);
    expect((await call(h, "DELETE", path, { auth: "user:alice" })).status).toBe(204);
    expect(h.cloudflare.liveTunnels()).toEqual([]);
    expect((await call(h, "GET", "/v1/instance", { auth: linked.instance_secret })).status).toBe(401);
  });

  it("finishes a failed removal from scheduled maintenance", async () => {
    const h = harness();
    const linked = await linkInstance(h);
    h.cloudflare.failNext("deleteTunnel", new CloudflareApiError("delete-tunnel", 500, [], "busy"));

    const removal = await call(h, "DELETE", `/v1/me/instances/${linked.instance_id}`, { auth: "user:alice" });
    expect(removal).toMatchObject({ status: 202, body: { status: "removing" } });
    expect((await call(h, "GET", "/v1/instance", { auth: linked.instance_secret })).status).toBe(401);
    const list = await call(h, "GET", "/v1/me/instances", { auth: "user:alice" });
    expect(list.body.instances[0].status).toBe("removing");

    h.advance(1);
    await runMaintenance(h.deps);
    expect(h.cloudflare.liveTunnels()).toEqual([]);
    expect(await h.store.getInstance(linked.instance_id)).toBeNull();
  });
});

describe("maintenance", () => {
  it("removes instances whose link was never collected", async () => {
    const h = harness();
    const link = await startLink(h);
    await call(h, "POST", `/v1/link-requests/${link.user_code}/approve`, { auth: "user:alice" });
    h.cloudflare.failNext("getTunnelToken");
    await poll(h, link.device_code);
    expect(h.cloudflare.liveTunnels()).toHaveLength(1);

    h.advance(2 * 60 * 60_000);
    await runMaintenance(h.deps);
    expect(h.cloudflare.liveTunnels()).toEqual([]);
    expect(h.cloudflare.records.size).toBe(0);
    expect(await h.store.findLinkRequestByUserCode(link.user_code)).toBeNull();
  });
});

describe("routing", () => {
  it("answers unknown paths and methods", async () => {
    const h = harness();
    expect((await call(h, "GET", "/v1/nope")).status).toBe(404);
    expect((await call(h, "PUT", "/v1/instance")).status).toBe(405);
  });

  it("describes the relay for Frigate and the pages", async () => {
    const h = harness();
    const info = await call(h, "GET", "/v1/info");
    expect(info.body).toEqual({
      service_name: "Test relay",
      dashboard_url: "https://relay.example.com/",
      clerk_publishable_key: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
      clerk_frontend_api: "clerk.example.com",
    });
  });
});
