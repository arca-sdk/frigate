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

  async ensureEndpoint(instance: InstanceRow, origin: Origin): Promise<EnsuredEndpoint> {
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

    if (current.dns_record_id === null || tunnelChanged) {
      const record = await this.pointHostnameAt(current, `${current.tunnel_id}.cfargotunnel.com`);
      if (record.id !== current.dns_record_id) {
        await this.store.setDnsRecord(current.id, record.id, this.now());
        current = { ...current, dns_record_id: record.id };
      }
    }

    return { instance: current, tunnelChanged };
  }

  /** Delete the instance's Cloudflare resources, then the instance. */
  async teardown(instance: InstanceRow): Promise<void> {
    const recordId = instance.dns_record_id ?? (await this.cloudflare.findDnsRecord(instance.hostname))?.id;
    if (recordId !== undefined) {
      await this.cloudflare.deleteDnsRecord(recordId);
    }
    const tunnelId =
      instance.tunnel_id ?? (await this.cloudflare.findTunnelByName(this.tunnelName(instance.id)))?.id;
    if (tunnelId !== undefined) {
      await this.cloudflare.deleteTunnel(tunnelId);
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
