export type ConnectState = "unlinked" | "linking" | "linked" | "revoked";

export type ConnectorState =
  "stopped" | "starting" | "connected" | "disconnected" | "failed";

export type ConnectStatus = {
  available: boolean;
  unavailable_reason: "not_configured" | "connector_missing" | null;
  blocked_reason: "auth_disabled" | null;
  dashboard_url: string | null;
  state: ConnectState;
  link: {
    user_code: string;
    verification_url: string;
    verification_url_complete: string;
    expires_at: number;
  } | null;
  name: string | null;
  hostname: string | null;
  url: string | null;
  account_label: string | null;
  linked_at: number | null;
  connector: {
    state: ConnectorState;
    connections: number;
    error: string | null;
  };
  relay_error: string | null;
  error: { code: string; message: string } | null;
};

export type TailscaleState =
  "off" | "starting" | "needs_login" | "needs_approval" | "running";

export type TailscaleServeState =
  "off" | "enabling" | "needs_https" | "on" | "error";

export type TailscaleStatus = {
  available: boolean;
  enabled: boolean;
  state: TailscaleState;
  auth_url: string | null;
  dns_name: string | null;
  tailnet: string | null;
  url: string | null;
  serve: TailscaleServeState;
  enable_https_url: string | null;
  error: string | null;
};

export type RemoteAccessStatus = {
  connect: ConnectStatus;
  tailscale: TailscaleStatus;
  security: {
    auth_enabled: boolean;
    login_rate_limit_enabled: boolean;
  };
  origin: { scheme: "http" | "https"; host: string; port: number };
};
