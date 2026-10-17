/** In-memory stand-ins for the relay's external services. */

import { env } from "cloudflare:workers";

import type { Dependencies } from "../src/app.ts";
import type { AccountDirectory, UserAuthenticator } from "../src/auth.ts";
import { CloudflareApiError, type CloudflareApi, type DnsRecord, type IngressRule, type Tunnel } from "../src/cloudflare.ts";
import type { RelayConfig } from "../src/config.ts";
import { HttpError, bearerToken } from "../src/http.ts";
import { Store } from "../src/store.ts";

interface FakeTunnel {
  id: string;
  name: string;
  status: string | null;
  deletedAt: string | null;
  ingress: readonly IngressRule[] | null;
  token: string;
}

type Operation = keyof CloudflareApi;

/** Behaves like the Cloudflare API for the calls the relay makes. */
export class FakeCloudflare implements CloudflareApi {
  readonly tunnels = new Map<string, FakeTunnel>();
  readonly records = new Map<string, DnsRecord>();
  readonly calls: Operation[] = [];
  private readonly failures = new Map<Operation, Error>();
  private sequence = 0;

  /** Make the next call to `operation` throw. */
  failNext(operation: Operation, error: Error = new CloudflareApiError(operation, 500, [], "boom")): void {
    this.failures.set(operation, error);
  }

  liveTunnels(): FakeTunnel[] {
    return [...this.tunnels.values()].filter((tunnel) => tunnel.deletedAt === null);
  }

  private enter(operation: Operation): void {
    this.calls.push(operation);
    const failure = this.failures.get(operation);
    if (failure !== undefined) {
      this.failures.delete(operation);
      throw failure;
    }
  }

  private view(tunnel: FakeTunnel): Tunnel {
    return { id: tunnel.id, name: tunnel.name, status: tunnel.status, deletedAt: tunnel.deletedAt };
  }

  async createTunnel(name: string): Promise<Tunnel> {
    this.enter("createTunnel");
    if (this.liveTunnels().some((tunnel) => tunnel.name === name)) {
      throw new CloudflareApiError("create-tunnel", 409, [1013], "You already have a tunnel with this name");
    }
    const id = `tunnel-${++this.sequence}`;
    const tunnel = { id, name, status: "inactive", deletedAt: null, ingress: null, token: `token-for-${id}` };
    this.tunnels.set(id, tunnel);
    return this.view(tunnel);
  }

  async getTunnel(id: string): Promise<Tunnel | null> {
    this.enter("getTunnel");
    const tunnel = this.tunnels.get(id);
    return tunnel === undefined ? null : this.view(tunnel);
  }

  async findTunnelByName(name: string): Promise<Tunnel | null> {
    this.enter("findTunnelByName");
    const tunnel = this.liveTunnels().find((candidate) => candidate.name === name);
    return tunnel === undefined ? null : this.view(tunnel);
  }

  async putTunnelIngress(id: string, ingress: readonly IngressRule[]): Promise<void> {
    this.enter("putTunnelIngress");
    const tunnel = this.tunnels.get(id);
    if (tunnel === undefined || tunnel.deletedAt !== null) {
      throw new CloudflareApiError("put-tunnel-configuration", 404, [], "not found");
    }
    tunnel.ingress = ingress;
  }

  async getTunnelToken(id: string): Promise<string> {
    this.enter("getTunnelToken");
    const tunnel = this.tunnels.get(id);
    if (tunnel === undefined || tunnel.deletedAt !== null) {
      throw new CloudflareApiError("get-tunnel-token", 404, [], "not found");
    }
    return tunnel.token;
  }

  async deleteTunnel(id: string): Promise<void> {
    this.enter("deleteTunnel");
    const tunnel = this.tunnels.get(id);
    if (tunnel !== undefined) {
      tunnel.deletedAt = "2026-01-01T00:00:00Z";
    }
  }

  async createProxiedCname(name: string, target: string): Promise<DnsRecord> {
    this.enter("createProxiedCname");
    if ([...this.records.values()].some((record) => record.name === name)) {
      throw new CloudflareApiError("create-dns-record", 400, [81053], "record already exists");
    }
    const record = { id: `record-${++this.sequence}`, name, content: target };
    this.records.set(record.id, record);
    return record;
  }

  async findDnsRecord(name: string): Promise<DnsRecord | null> {
    this.enter("findDnsRecord");
    return [...this.records.values()].find((record) => record.name === name) ?? null;
  }

  async updateDnsRecordTarget(id: string, target: string): Promise<boolean> {
    this.enter("updateDnsRecordTarget");
    const record = this.records.get(id);
    if (record === undefined) {
      return false;
    }
    this.records.set(id, { ...record, content: target });
    return true;
  }

  async deleteDnsRecord(id: string): Promise<void> {
    this.enter("deleteDnsRecord");
    this.records.delete(id);
  }
}

/** Accepts `Bearer user:<id>` as a signed-in session for `<id>`. */
export const fakeUsers: UserAuthenticator = {
  async authenticate(request) {
    const token = bearerToken(request);
    if (token === null || !token.startsWith("user:")) {
      throw new HttpError(401, "unauthenticated", "Sign in first");
    }
    return { userId: token.slice("user:".length) };
  },
};

export const fakeAccounts: AccountDirectory = {
  async labelFor(userId) {
    return `${userId}@example.com`;
  },
};

export const TEST_CONFIG: RelayConfig = {
  serviceName: "Test relay",
  publicUrl: "https://relay.example.com",
  tunnelZoneName: "tunnels.example.net",
  cloudflareAccountId: "account",
  cloudflareZoneId: "zone",
  cloudflareApiToken: "api-token",
  clerkPublishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
  clerkSecretKey: "sk_test",
  tunnelNamePrefix: "test",
  maxInstancesPerUser: 2,
};

export interface Harness {
  readonly deps: Dependencies;
  readonly cloudflare: FakeCloudflare;
  readonly store: Store;
  advance(ms: number): void;
}

export function harness(overrides: Partial<Dependencies> = {}): Harness {
  let clock = 1_800_000_000_000;
  const cloudflare = new FakeCloudflare();
  const store = new Store(env.DB);
  return {
    deps: {
      config: TEST_CONFIG,
      store,
      cloudflare,
      users: fakeUsers,
      accounts: fakeAccounts,
      now: () => clock,
      ...overrides,
    },
    cloudflare,
    store,
    advance(ms) {
      clock += ms;
    },
  };
}
