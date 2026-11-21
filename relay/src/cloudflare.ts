/** The Cloudflare API calls the relay makes to manage tunnels and DNS. */

export interface Tunnel {
  readonly id: string;
  readonly name: string;
  /** `healthy`, `degraded`, `down` or `inactive`. */
  readonly status: string | null;
  readonly deletedAt: string | null;
}

export interface IngressRule {
  readonly hostname?: string;
  readonly service: string;
  readonly originRequest?: { readonly noTLSVerify?: boolean };
}

export interface DnsRecord {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

export interface CloudflareApi {
  createTunnel(name: string): Promise<Tunnel>;
  /** Null when the tunnel does not exist. A deleted tunnel has `deletedAt`. */
  getTunnel(id: string): Promise<Tunnel | null>;
  /** The tunnel with this name that has not been deleted, if any. */
  findTunnelByName(name: string): Promise<Tunnel | null>;
  putTunnelIngress(id: string, ingress: readonly IngressRule[]): Promise<void>;
  getTunnelToken(id: string): Promise<string>;
  /** Succeeds when the tunnel is already gone. */
  deleteTunnel(id: string): Promise<void>;
  createProxiedCname(name: string, target: string, comment: string): Promise<DnsRecord>;
  findDnsRecord(name: string): Promise<DnsRecord | null>;
  /** Returns false when the record no longer exists. */
  updateDnsRecordTarget(id: string, target: string): Promise<boolean>;
  /** Succeeds when the record is already gone. */
  deleteDnsRecord(id: string): Promise<void>;
}

export class CloudflareApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly codes: readonly number[],
    detail: string,
  ) {
    super(`Cloudflare ${operation} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

// Cloudflare error codes for a name that is already taken.
const TUNNEL_NAME_TAKEN = 1013;
const DNS_RECORD_EXISTS = 81053;

export function isTunnelNameTaken(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 409 || error.codes.includes(TUNNEL_NAME_TAKEN))
  );
}

export function isDnsRecordTaken(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.codes.includes(DNS_RECORD_EXISTS);
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 8_000;

interface Envelope<T> {
  readonly success?: boolean;
  readonly errors?: ReadonlyArray<{ readonly code?: number; readonly message?: string }>;
  readonly result?: T;
}

interface TunnelResult {
  readonly id: string;
  readonly name: string;
  readonly status?: string | null;
  readonly deleted_at?: string | null;
}

interface DnsRecordResult {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

function toTunnel(result: TunnelResult): Tunnel {
  return {
    id: result.id,
    name: result.name,
    status: result.status ?? null,
    deletedAt: result.deleted_at ?? null,
  };
}

export function createCloudflareApi(options: {
  readonly accountId: string;
  readonly zoneId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}): CloudflareApi {
  const send = options.fetch ?? fetch;
  const account = `/accounts/${encodeURIComponent(options.accountId)}`;
  const zone = `/zones/${encodeURIComponent(options.zoneId)}`;

  async function call<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await send(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let envelope: Envelope<T> = {};
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      // A non-JSON body only matters when the status is also an error.
    }
    if (!response.ok || envelope.success === false) {
      const errors = envelope.errors ?? [];
      throw new CloudflareApiError(
        operation,
        response.status,
        errors.flatMap((error) => (typeof error.code === "number" ? [error.code] : [])),
        errors.map((error) => error.message ?? "").filter(Boolean).join("; "),
      );
    }
    return envelope.result as T;
  }

  async function ignoreNotFound(operation: Promise<unknown>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      if (!(error instanceof CloudflareApiError && error.notFound)) {
        throw error;
      }
    }
  }

  return {
    async createTunnel(name) {
      return toTunnel(
        await call<TunnelResult>("create-tunnel", "POST", `${account}/cfd_tunnel`, {
          name,
          config_src: "cloudflare",
        }),
      );
    },

    async getTunnel(id) {
      try {
        return toTunnel(
          await call<TunnelResult>("get-tunnel", "GET", `${account}/cfd_tunnel/${encodeURIComponent(id)}`),
        );
      } catch (error) {
        if (error instanceof CloudflareApiError && error.notFound) {
          return null;
        }
        throw error;
      }
    },

    async findTunnelByName(name) {
      const query = new URLSearchParams({ name, is_deleted: "false" });
      const results = await call<TunnelResult[]>("list-tunnels", "GET", `${account}/cfd_tunnel?${query}`);
      const match = (results ?? []).find((tunnel) => tunnel.name === name && !tunnel.deleted_at);
      return match ? toTunnel(match) : null;
    },

    async putTunnelIngress(id, ingress) {
      await call(
        "put-tunnel-configuration",
        "PUT",
        `${account}/cfd_tunnel/${encodeURIComponent(id)}/configurations`,
        { config: { ingress } },
      );
    },

    async getTunnelToken(id) {
      return call<string>("get-tunnel-token", "GET", `${account}/cfd_tunnel/${encodeURIComponent(id)}/token`);
    },

    async deleteTunnel(id) {
      const path = `${account}/cfd_tunnel/${encodeURIComponent(id)}`;
      // Cloudflare refuses to delete a tunnel that still has connectors, and an
      // unlinked Frigate may not have stopped its connector yet.
      await ignoreNotFound(call("delete-tunnel-connections", "DELETE", `${path}/connections`));
      await ignoreNotFound(call("delete-tunnel", "DELETE", path));
    },

    async createProxiedCname(name, target, comment) {
      const record = await call<DnsRecordResult>("create-dns-record", "POST", `${zone}/dns_records`, {
        type: "CNAME",
        name,
        content: target,
        proxied: true,
        ttl: 1,
        comment,
      });
      return { id: record.id, name: record.name, content: record.content };
    },

    async findDnsRecord(name) {
      const query = new URLSearchParams({ name });
      const results = await call<DnsRecordResult[]>("list-dns-records", "GET", `${zone}/dns_records?${query}`);
      const wanted = name.toLowerCase();
      const match = (results ?? []).find((record) => record.name.toLowerCase() === wanted);
      return match ? { id: match.id, name: match.name, content: match.content } : null;
    },

    async updateDnsRecordTarget(id, target) {
      try {
        await call("update-dns-record", "PATCH", `${zone}/dns_records/${encodeURIComponent(id)}`, {
          content: target,
        });
        return true;
      } catch (error) {
        if (error instanceof CloudflareApiError && error.notFound) {
          return false;
        }
        throw error;
      }
    },

    async deleteDnsRecord(id) {
      await ignoreNotFound(call("delete-dns-record", "DELETE", `${zone}/dns_records/${encodeURIComponent(id)}`));
    },
  };
}
