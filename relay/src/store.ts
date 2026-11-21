/** D1 access for link requests and linked instances. */

import type { Origin } from "./origin.ts";

export type LinkRequestStatus = "pending" | "approved" | "denied" | "completed";
export type InstanceState = "provisioning" | "active" | "deleting";

export interface LinkRequestRow {
  readonly id: string;
  readonly device_code_hash: string;
  readonly user_code: string;
  readonly instance_name: string;
  readonly origin_scheme: Origin["scheme"];
  readonly origin_host: string;
  readonly origin_port: number;
  readonly status: LinkRequestStatus;
  readonly user_id: string | null;
  readonly account_label: string | null;
  readonly instance_id: string | null;
  readonly claimed_until: number | null;
  readonly created_at: number;
  readonly expires_at: number;
}

export interface InstanceRow {
  readonly id: string;
  readonly user_id: string;
  readonly account_label: string | null;
  readonly name: string;
  readonly hostname: string;
  readonly secret_hash: string | null;
  readonly origin_scheme: Origin["scheme"];
  readonly origin_host: string;
  readonly origin_port: number;
  readonly tunnel_id: string | null;
  readonly dns_record_id: string | null;
  readonly dns_target: string | null;
  readonly configured_origin: string | null;
  readonly state: InstanceState;
  readonly busy_until: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_sync_at: number | null;
}

export type ApprovalResult = "approved" | "already_decided" | "limit_reached";

export function originOf(row: LinkRequestRow | InstanceRow): Origin {
  return { scheme: row.origin_scheme, host: row.origin_host, port: row.origin_port };
}

const INSTANCE_COLUMNS = `id, user_id, account_label, name, hostname, secret_hash,
  origin_scheme, origin_host, origin_port, tunnel_id, dns_record_id, dns_target,
  configured_origin, state, busy_until, created_at, updated_at, last_sync_at`;

export class Store {
  constructor(private readonly db: D1Database) {}

  async insertLinkRequest(row: LinkRequestRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO link_requests (id, device_code_hash, user_code, instance_name,
           origin_scheme, origin_host, origin_port, status, user_id, account_label,
           instance_id, claimed_until, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.device_code_hash,
        row.user_code,
        row.instance_name,
        row.origin_scheme,
        row.origin_host,
        row.origin_port,
        row.status,
        row.user_id,
        row.account_label,
        row.instance_id,
        row.claimed_until,
        row.created_at,
        row.expires_at,
      )
      .run();
  }

  findLinkRequestById(id: string): Promise<LinkRequestRow | null> {
    return this.db.prepare("SELECT * FROM link_requests WHERE id = ?").bind(id).first<LinkRequestRow>();
  }

  findLinkRequestByDeviceCodeHash(hash: string): Promise<LinkRequestRow | null> {
    return this.db
      .prepare("SELECT * FROM link_requests WHERE device_code_hash = ?")
      .bind(hash)
      .first<LinkRequestRow>();
  }

  findLinkRequestByUserCode(userCode: string): Promise<LinkRequestRow | null> {
    return this.db
      .prepare("SELECT * FROM link_requests WHERE user_code = ?")
      .bind(userCode)
      .first<LinkRequestRow>();
  }

  /**
   * Approve a pending request if the account has room for another instance.
   *
   * Approved requests that have not created their instance yet count against
   * the limit too, and the check and the approval are one statement, so
   * approving several codes at once cannot get past it.
   */
  async approveLinkRequest(
    id: string,
    approval: { userId: string; accountLabel: string | null; limit: number },
    now: number,
  ): Promise<ApprovalResult> {
    const result = await this.db
      .prepare(
        `UPDATE link_requests SET status = 'approved', user_id = ?, account_label = ?
         WHERE id = ? AND status = 'pending' AND expires_at > ?
           AND (SELECT COUNT(*) FROM instances WHERE user_id = ? AND state != 'deleting')
             + (SELECT COUNT(*) FROM link_requests
                WHERE user_id = ? AND status = 'approved' AND instance_id IS NULL AND expires_at > ?)
             < ?`,
      )
      .bind(approval.userId, approval.accountLabel, id, now, approval.userId, approval.userId, now, approval.limit)
      .run();
    if (result.meta.changes === 1) {
      return "approved";
    }
    const row = await this.findLinkRequestById(id);
    return row === null || row.status !== "pending" || row.expires_at <= now ? "already_decided" : "limit_reached";
  }

  /** Decline a pending request. False when it was already decided or expired. */
  async denyLinkRequest(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE link_requests SET status = 'denied'
         WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .bind(id, now)
      .run();
    return result.meta.changes === 1;
  }

  /** Take the provisioning lease. False while another poll holds it. */
  async claimLinkRequest(id: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE link_requests SET claimed_until = ?
         WHERE id = ? AND status IN ('approved', 'completed')
           AND (claimed_until IS NULL OR claimed_until <= ?)`,
      )
      .bind(now + leaseMs, id, now)
      .run();
    return result.meta.changes === 1;
  }

  async releaseLinkRequest(id: string): Promise<void> {
    await this.db.prepare("UPDATE link_requests SET claimed_until = NULL WHERE id = ?").bind(id).run();
  }

  async completeLinkRequest(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE link_requests SET status = 'completed', claimed_until = NULL WHERE id = ?")
      .bind(id)
      .run();
  }

  async deleteLinkRequest(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM link_requests WHERE id = ?").bind(id).run();
  }

  async deleteLinkRequestsExpiredBefore(cutoff: number): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM link_requests WHERE expires_at < ?")
      .bind(cutoff)
      .run();
    return result.meta.changes;
  }

  /**
   * Create the instance for a request that has none yet, in one transaction.
   * Returns the request's instance id, which is an earlier attempt's when one
   * already assigned it.
   */
  async createInstanceForLinkRequest(linkRequestId: string, instance: InstanceRow): Promise<string | null> {
    await this.db.batch([
      this.db
        .prepare("UPDATE link_requests SET instance_id = ? WHERE id = ? AND instance_id IS NULL")
        .bind(instance.id, linkRequestId),
      // Only inserted when the assignment above won.
      this.db
        .prepare(
          `INSERT INTO instances (${INSTANCE_COLUMNS})
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM link_requests WHERE id = ? AND instance_id = ?)`,
        )
        .bind(
          instance.id,
          instance.user_id,
          instance.account_label,
          instance.name,
          instance.hostname,
          instance.secret_hash,
          instance.origin_scheme,
          instance.origin_host,
          instance.origin_port,
          instance.tunnel_id,
          instance.dns_record_id,
          instance.dns_target,
          instance.configured_origin,
          instance.state,
          instance.busy_until,
          instance.created_at,
          instance.updated_at,
          instance.last_sync_at,
          linkRequestId,
          instance.id,
        ),
    ]);
    return (await this.findLinkRequestById(linkRequestId))?.instance_id ?? null;
  }

  getInstance(id: string): Promise<InstanceRow | null> {
    return this.db.prepare("SELECT * FROM instances WHERE id = ?").bind(id).first<InstanceRow>();
  }

  async listInstancesForUser(userId: string): Promise<InstanceRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM instances WHERE user_id = ? ORDER BY created_at")
      .bind(userId)
      .all<InstanceRow>();
    return results;
  }

  async listInstancesInState(state: InstanceState, createdBefore: number, limit: number): Promise<InstanceRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM instances WHERE state = ? AND created_at < ? ORDER BY updated_at LIMIT ?")
      .bind(state, createdBefore, limit)
      .all<InstanceRow>();
    return results;
  }

  /** Take the instance's lease for Cloudflare work. False while someone else holds it. */
  async claimInstance(id: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE instances SET busy_until = ?
         WHERE id = ? AND (busy_until IS NULL OR busy_until <= ?)`,
      )
      .bind(now + leaseMs, id, now)
      .run();
    return result.meta.changes === 1;
  }

  async releaseInstance(id: string): Promise<void> {
    await this.db.prepare("UPDATE instances SET busy_until = NULL WHERE id = ?").bind(id).run();
  }

  async setTunnel(id: string, tunnelId: string, now: number): Promise<void> {
    // A new tunnel has no ingress yet, whatever the old one had.
    await this.db
      .prepare("UPDATE instances SET tunnel_id = ?, configured_origin = NULL, updated_at = ? WHERE id = ?")
      .bind(tunnelId, now, id)
      .run();
  }

  async setOrigin(id: string, origin: Origin, configuredOrigin: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE instances SET origin_scheme = ?, origin_host = ?, origin_port = ?,
           configured_origin = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(origin.scheme, origin.host, origin.port, configuredOrigin, now, id)
      .run();
  }

  async setDnsRecord(id: string, dnsRecordId: string, target: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE instances SET dns_record_id = ?, dns_target = ?, updated_at = ? WHERE id = ?")
      .bind(dnsRecordId, target, now, id)
      .run();
  }

  /** Issue a new secret, which replaces any earlier one, and mark the instance usable. */
  async activateInstance(id: string, secretHash: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE instances SET secret_hash = ?, state = 'active', updated_at = ?, last_sync_at = ?
         WHERE id = ? AND state != 'deleting'`,
      )
      .bind(secretHash, now, now, id)
      .run();
    return result.meta.changes === 1;
  }

  async recordSync(id: string, name: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE instances SET name = ?, last_sync_at = ?, updated_at = ? WHERE id = ?")
      .bind(name, now, now, id)
      .run();
  }

  /** Revoke the instance's access before its resources are torn down. */
  async markDeleting(id: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE instances SET state = 'deleting', secret_hash = NULL, updated_at = ? WHERE id = ?")
      .bind(now, id)
      .run();
  }

  async deleteInstance(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM instances WHERE id = ? AND state = 'deleting'").bind(id).run();
  }
}
