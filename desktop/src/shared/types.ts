/** Types shared by the main process, the preload script and the server list page. */

/** The parts of a TLS certificate shown when asking the user to trust it. */
export type CertificateInfo = {
  /** Electron's fingerprint string, e.g. "sha256/<base64>". */
  fingerprint: string;
  subjectName: string;
  issuerName: string;
  /** Seconds since the epoch. */
  validStart: number;
  /** Seconds since the epoch. */
  validExpiry: number;
};

/** A saved server, as written to servers.json. */
export type ServerRecord = {
  id: string;
  name: string;
  /** Normalized base URL ending with "/", e.g. "https://frigate.local:8971/". */
  url: string;
  /**
   * Fingerprint of a certificate the user chose to trust because the system
   * doesn't (Frigate's self-signed one). Null when the system trusts it.
   */
  certificateFingerprint: string | null;
  /** False when the server let us in without signing in (auth is off). */
  loginRequired: boolean;
};

/** Why a saved server couldn't be opened the last time we tried. */
export type ServerProblem =
  | { kind: "unreachable"; error: string }
  | { kind: "rejected"; reason: AddServerRejection }
  | { kind: "redirected"; address: string }
  | { kind: "untrusted_certificate"; certificate: CertificateInfo }
  | { kind: "certificate_changed"; certificate: CertificateInfo }
  /**
   * The server's session already rejected the certificate the user just
   * trusted. Chromium caches that until the app restarts.
   */
  | { kind: "restart_required" };

/** A saved server as the server list shows it. */
export type ServerView = ServerRecord & {
  encrypted: boolean;
  /** Being checked before its window opens. */
  checking: boolean;
  problem: ServerProblem | null;
};

export type AddServerRequest = {
  url: string;
  name: string;
  /** Set when the user accepted the certificate a previous attempt returned. */
  trustedFingerprint?: string;
};

/** Reasons the address itself, or what answered at it, can't be added. */
export type AddServerRejection =
  | "invalid_url"
  | "unsupported_scheme"
  | "internal_port"
  | "not_frigate"
  | "duplicate";

export type AddServerResult =
  | { kind: "added"; server: ServerView }
  | { kind: "rejected"; reason: AddServerRejection }
  /** The server redirected to another address, which should be added instead. */
  | { kind: "redirected"; address: string }
  | { kind: "unreachable"; error: string }
  | { kind: "untrusted_certificate"; certificate: CertificateInfo };

/** What the preload script exposes to the server list page as `window.servers`. */
export type ServersApi = {
  list(): Promise<ServerView[]>;
  add(request: AddServerRequest): Promise<AddServerResult>;
  open(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  trustCertificate(id: string, fingerprint: string): Promise<void>;
  restart(): Promise<void>;
  onChanged(listener: (servers: ServerView[]) => void): void;
};

/** IPC channel names, shared so the two sides can't drift apart. */
export const IPC = {
  list: "servers:list",
  add: "servers:add",
  open: "servers:open",
  remove: "servers:remove",
  trustCertificate: "servers:trust-certificate",
  restart: "app:restart",
  changed: "servers:changed",
} as const;
