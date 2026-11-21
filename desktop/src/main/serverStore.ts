/** The saved server list, kept in servers.json in the app's user data folder. */

import fs from "node:fs";
import path from "node:path";

import type { ServerRecord } from "../shared/types";
import { parseServerUrl } from "./serverUrl";

const FILE_VERSION = 1;

export class ServerStore {
  private servers: ServerRecord[] = [];

  constructor(private readonly file: string) {}

  /** Read the file. A missing file is an empty list; unreadable entries are skipped. */
  load(): void {
    let raw: string;

    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.servers = [];
        return;
      }
      throw error;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      // Keep the unreadable file for inspection rather than overwriting it
      // with an empty list on the next save.
      fs.renameSync(this.file, `${this.file}.invalid`);
      this.servers = [];
      return;
    }

    const entries =
      typeof parsed === "object" && parsed !== null && "servers" in parsed
        ? (parsed as { servers: unknown }).servers
        : [];
    this.servers = Array.isArray(entries) ? entries.filter(isServerRecord) : [];
  }

  list(): ServerRecord[] {
    return this.servers.map((server) => ({ ...server }));
  }

  get(id: string): ServerRecord | undefined {
    const server = this.servers.find((candidate) => candidate.id === id);
    return server && { ...server };
  }

  findByUrl(url: string): ServerRecord | undefined {
    const server = this.servers.find((candidate) => candidate.url === url);
    return server && { ...server };
  }

  add(server: ServerRecord): void {
    this.servers.push({ ...server });
    this.save();
  }

  update(id: string, changes: Partial<Omit<ServerRecord, "id">>): void {
    this.servers = this.servers.map((server) =>
      server.id === id ? { ...server, ...changes } : server,
    );
    this.save();
  }

  remove(id: string): void {
    this.servers = this.servers.filter((server) => server.id !== id);
    this.save();
  }

  /** Write to a temporary file and rename it, so a crash can't leave half a file. */
  private save(): void {
    const temporary = `${this.file}.tmp`;
    const contents = JSON.stringify(
      { version: FILE_VERSION, servers: this.servers },
      null,
      2,
    );

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, contents, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

function isServerRecord(value: unknown): value is ServerRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.url === "string" &&
    parseServerUrl(record.url).ok &&
    (record.certificateFingerprint === null ||
      typeof record.certificateFingerprint === "string") &&
    typeof record.loginRequired === "boolean"
  );
}
