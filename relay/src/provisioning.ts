/**
 * Creates, repairs and removes the Cloudflare tunnel and DNS record behind
 * each instance's hostname.
 *
 * Every step records what it created before moving on, so a request that dies
 * part way leaves state the next attempt adopts instead of duplicating.
 */

import {
  type CloudflareApi,
  type DnsRecord,
  type IngressRule,
  type Tunnel,
  isDnsRecordTaken,
  isTunnelNameTaken,
} from "./cloudflare.ts";
import { type Origin, originService } from "./origin.ts";
import type { InstanceRow, Store } from "./store.ts";

/** Another request is creating or removing this instance's resources. */
export class InstanceBusyError extends Error {
  constructor() {
    super("instance is busy");
  }
}

/** The instance was removed, or is being removed. */
export class InstanceGoneError extends Error {
  constructor() {
    super("instance was removed");
  }
}

/** Longer than a full provisioning pass, whose Cloudflare calls time out after 8 seconds each. */
export const INSTANCE_LEASE_MS = 2 * 60_000;

export interface EnsuredEndpoint {
  readonly instance: InstanceRow;
  /**
   * The tunnel was created or replaced, so the Frigate needs the new token;
   * the one it holds belongs to a tunnel that no longer exists.
   */
  readonly tunnelChanged: boolean;
}

export function ingressFor(hostname: string, origin: Origin): IngressRule[] {
  return [
    {
      hostname,
      service: originService(origin),
      // The authenticated port uses a self-signed certificate by default, and
      // the hop is inside the Frigate's own host.
      ...(origin.scheme === "https" ? { originRequest: { noTLSVerify: true } } : {}),
    },
    { service: "http_status:404" },
  ];
}

export class Provisioner {
  constructor(
    private readonly store: Store,
    private readonly cloudflare: CloudflareApi,
    private readonly tunnelNamePrefix: string,
    private readonly now: () => number,
  ) {}

  tunnelName(instanceId: string): string {
    return `${this.tunnelNamePrefix}-${instanceId}`;
  }

  /**
   * Run Cloudflare work on one instance while holding its lease, so setup and
   * removal never overlap and neither leaves behind resources the other
   * cannot see. The work gets the instance as it is once the lease is held.
   */
  async withLease<T>(instanceId: string, work: (instance: InstanceRow) => Promise<T>): Promise<T> {
    if (!(await this.store.claimInstance(instanceId, this.now(), INSTANCE_LEASE_MS))) {
      // The claim also fails when there is no row left to claim.
      throw (await this.store.getInstance(instanceId)) === null ? new InstanceGoneError() : new InstanceBusyError();
    }
    try {
      const instance = await this.store.getInstance(instanceId);
      if (instance === null) {
        throw new InstanceGoneError();
      }
      return await work(instance);
    } finally {
      await this.store.releaseInstance(instanceId);
    }
  }

  /** Call while holding the instance's lease. */
  async ensureEndpoint(instance: InstanceRow, origin: Origin): Promise<EnsuredEndpoint> {
    if (instance.state === "deleting") {
      // Removal revoked it; creating resources now would only leak them.
      throw new InstanceGoneError();
    }
    let current = instance;
    let tunnelChanged = false;

    if (current.tunnel_id !== null) {
      // Someone may have deleted the tunnel from the Cloudflare dashboard.
      const tunnel = await this.cloudflare.getTunnel(current.tunnel_id);
      if (tunnel === null || tunnel.deletedAt !== null) {
        current = { ...current, tunnel_id: null };
      }
    }
    if (current.tunnel_id === null) {
      const tunnel = await this.createOrAdoptTunnel(this.tunnelName(current.id));
      await this.store.setTunnel(current.id, tunnel.id, this.now());
      current = { ...current, tunnel_id: tunnel.id, configured_origin: null };
      tunnelChanged = true;
    }

    const service = originService(origin);
    if (current.configured_origin !== service) {
      await this.cloudflare.putTunnelIngress(current.tunnel_id!, ingressFor(current.hostname, origin));
      await this.store.setOrigin(current.id, origin, service, this.now());
      current = {
        ...current,
        configured_origin: service,
        origin_scheme: origin.scheme,
        origin_host: origin.host,
        origin_port: origin.port,
      };
    }

    // Compared with what the record was last pointed at, not with whether
    // this call replaced the tunnel: a replacement that failed before
    // updating DNS is only noticed by the retry this way.
    const target = `${current.tunnel_id}.cfargotunnel.com`;
    if (current.dns_record_id === null || current.dns_target !== target) {
      const record = await this.pointHostnameAt(current, target);
      await this.store.setDnsRecord(current.id, record.id, target, this.now());
      // The hostname pointed at another tunnel, so the Frigate's token is for
      // that one, even when this call did not create the new tunnel.
      tunnelChanged = tunnelChanged || current.dns_target !== null;
      current = { ...current, dns_record_id: record.id, dns_target: target };
    }

    return { instance: current, tunnelChanged };
  }

  /**
   * Delete the instance's Cloudflare resources, then the instance. Call while
   * holding its lease. Resources are also looked up by name, which finds any
   * that an attempt created but did not live to record.
   */
  async teardown(instance: InstanceRow): Promise<void> {
    const found = await this.cloudflare.findDnsRecord(instance.hostname);
    for (const recordId of new Set([instance.dns_record_id, found?.id])) {
      if (recordId) {
        await this.cloudflare.deleteDnsRecord(recordId);
      }
    }
    const named = await this.cloudflare.findTunnelByName(this.tunnelName(instance.id));
    for (const tunnelId of new Set([instance.tunnel_id, named?.id])) {
      if (tunnelId) {
        await this.cloudflare.deleteTunnel(tunnelId);
      }
    }
    await this.store.deleteInstance(instance.id);
  }

  private async createOrAdoptTunnel(name: string): Promise<Tunnel> {
    // An attempt whose response was lost may already have created it.
    const existing = await this.cloudflare.findTunnelByName(name);
    if (existing !== null) {
      return existing;
    }
    try {
      return await this.cloudflare.createTunnel(name);
    } catch (error) {
      if (isTunnelNameTaken(error)) {
        const adopted = await this.cloudflare.findTunnelByName(name);
        if (adopted !== null) {
          return adopted;
        }
      }
      throw error;
    }
  }

  private async pointHostnameAt(instance: InstanceRow, target: string): Promise<DnsRecord> {
    if (instance.dns_record_id !== null) {
      if (await this.cloudflare.updateDnsRecordTarget(instance.dns_record_id, target)) {
        return { id: instance.dns_record_id, name: instance.hostname, content: target };
      }
    }
    try {
      return await this.cloudflare.createProxiedCname(instance.hostname, target, `instance ${instance.id}`);
    } catch (error) {
      if (!isDnsRecordTaken(error)) {
        throw error;
      }
      // Created by an attempt whose response was lost. Hostnames contain the
      // random instance id, so no other instance can own this record.
      const existing = await this.cloudflare.findDnsRecord(instance.hostname);
      if (existing === null) {
        throw error;
      }
      if (existing.content !== target) {
        await this.cloudflare.updateDnsRecordTarget(existing.id, target);
      }
      return { ...existing, content: target };
    }
  }
}
