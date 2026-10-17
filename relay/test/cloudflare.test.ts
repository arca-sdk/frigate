import { describe, expect, it } from "vitest";

import { CloudflareApiError, createCloudflareApi, isDnsRecordTaken, isTunnelNameTaken } from "../src/cloudflare.ts";

interface Recorded {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const requests: Recorded[] = [];
  const send = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: request.headers.get("authorization"),
    });
    const next = responses.shift() ?? { body: { success: true, result: null } };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { requests, fetch: send as typeof fetch };
}

function api(responses: Array<{ status?: number; body: unknown }>) {
  const recorder = fakeFetch(responses);
  return {
    ...recorder,
    client: createCloudflareApi({ accountId: "acct", zoneId: "zone", apiToken: "secret", fetch: recorder.fetch }),
  };
}

const BASE = "https://api.cloudflare.com/client/v4";

describe("Cloudflare API client", () => {
  it("creates a remotely managed tunnel", async () => {
    const { client, requests } = api([
      { body: { success: true, result: { id: "t1", name: "relay-x", status: "inactive", deleted_at: null } } },
    ]);
    expect(await client.createTunnel("relay-x")).toEqual({
      id: "t1",
      name: "relay-x",
      status: "inactive",
      deletedAt: null,
    });
    expect(requests).toEqual([
      {
        method: "POST",
        url: `${BASE}/accounts/acct/cfd_tunnel`,
        body: { name: "relay-x", config_src: "cloudflare" },
        authorization: "Bearer secret",
      },
    ]);
  });

  it("maps a missing tunnel to null", async () => {
    const { client } = api([{ status: 404, body: { success: false, errors: [{ code: 1003, message: "not found" }] } }]);
    expect(await client.getTunnel("gone")).toBeNull();
  });

  it("finds a tunnel by exact name", async () => {
    const { client, requests } = api([
      {
        body: {
          success: true,
          result: [
            { id: "t0", name: "relay-x-old", deleted_at: null },
            { id: "t1", name: "relay-x", deleted_at: null },
          ],
        },
      },
    ]);
    expect((await client.findTunnelByName("relay-x"))?.id).toBe("t1");
    expect(requests[0]?.url).toBe(`${BASE}/accounts/acct/cfd_tunnel?name=relay-x&is_deleted=false`);
  });

  it("writes the ingress as the tunnel's remote configuration", async () => {
    const { client, requests } = api([{ body: { success: true, result: {} } }]);
    await client.putTunnelIngress("t1", [{ hostname: "a.example.net", service: "https://127.0.0.1:8971" }]);
    expect(requests[0]).toMatchObject({
      method: "PUT",
      url: `${BASE}/accounts/acct/cfd_tunnel/t1/configurations`,
      body: { config: { ingress: [{ hostname: "a.example.net", service: "https://127.0.0.1:8971" }] } },
    });
  });

  it("removes connectors before deleting a tunnel and tolerates either being gone", async () => {
    const { client, requests } = api([
      { status: 404, body: { success: false, errors: [] } },
      { body: { success: true, result: {} } },
    ]);
    await client.deleteTunnel("t1");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `DELETE ${BASE}/accounts/acct/cfd_tunnel/t1/connections`,
      `DELETE ${BASE}/accounts/acct/cfd_tunnel/t1`,
    ]);
  });

  it("creates a proxied CNAME", async () => {
    const { client, requests } = api([
      { body: { success: true, result: { id: "r1", name: "a.example.net", content: "t1.cfargotunnel.com" } } },
    ]);
    await client.createProxiedCname("a.example.net", "t1.cfargotunnel.com", "instance a");
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: `${BASE}/zones/zone/dns_records`,
      body: {
        type: "CNAME",
        name: "a.example.net",
        content: "t1.cfargotunnel.com",
        proxied: true,
        ttl: 1,
        comment: "instance a",
      },
    });
  });

  it("reports a missing DNS record on update", async () => {
    const { client } = api([{ status: 404, body: { success: false, errors: [] } }]);
    expect(await client.updateDnsRecordTarget("r1", "t2.cfargotunnel.com")).toBe(false);
  });

  it("surfaces API errors with their codes", async () => {
    const { client } = api([
      { status: 400, body: { success: false, errors: [{ code: 81053, message: "record already exists" }] } },
    ]);
    const error = await client.createProxiedCname("a", "b", "c").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(isDnsRecordTaken(error)).toBe(true);
    expect(isTunnelNameTaken(error)).toBe(false);
    expect(String(error)).not.toContain("secret");
  });

  it("treats success: false as a failure even with HTTP 200", async () => {
    const { client } = api([{ body: { success: false, errors: [{ code: 1013, message: "name taken" }] } }]);
    const error = await client.createTunnel("x").catch((caught: unknown) => caught);
    expect(isTunnelNameTaken(error)).toBe(true);
  });
});
