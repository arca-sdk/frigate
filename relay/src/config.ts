/** Relay settings, read from the Worker's vars and secrets. */

export type RelayEnv = Env & {
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly CLERK_SECRET_KEY?: string;
};

export interface RelayConfig {
  readonly serviceName: string;
  /** Origin of the relay's pages and API, or null to use the request's. */
  readonly publicUrl: string | null;
  readonly tunnelZoneName: string;
  readonly cloudflareAccountId: string;
  readonly cloudflareZoneId: string;
  readonly cloudflareApiToken: string;
  readonly clerkPublishableKey: string;
  readonly clerkSecretKey: string;
  readonly tunnelNamePrefix: string;
  readonly maxInstancesPerUser: number;
}

export class RelayNotConfiguredError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Relay is missing settings: ${missing.join(", ")}`);
  }
}

export function loadConfig(env: RelayEnv): RelayConfig {
  const read = (name: keyof RelayEnv): string => {
    const value = env[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const required = {
    TUNNEL_ZONE_NAME: read("TUNNEL_ZONE_NAME"),
    CLOUDFLARE_ACCOUNT_ID: read("CLOUDFLARE_ACCOUNT_ID"),
    CLOUDFLARE_ZONE_ID: read("CLOUDFLARE_ZONE_ID"),
    CLOUDFLARE_API_TOKEN: read("CLOUDFLARE_API_TOKEN"),
    CLERK_PUBLISHABLE_KEY: read("CLERK_PUBLISHABLE_KEY"),
    CLERK_SECRET_KEY: read("CLERK_SECRET_KEY"),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new RelayNotConfiguredError(missing);
  }

  const publicUrl = read("PUBLIC_URL");
  const maxInstances = Number.parseInt(read("MAX_INSTANCES_PER_USER"), 10);
  return {
    serviceName: read("SERVICE_NAME") || "Remote access",
    publicUrl: publicUrl ? new URL(publicUrl).origin : null,
    tunnelZoneName: required.TUNNEL_ZONE_NAME.toLowerCase().replace(/\.$/u, ""),
    cloudflareAccountId: required.CLOUDFLARE_ACCOUNT_ID,
    cloudflareZoneId: required.CLOUDFLARE_ZONE_ID,
    cloudflareApiToken: required.CLOUDFLARE_API_TOKEN,
    clerkPublishableKey: required.CLERK_PUBLISHABLE_KEY,
    clerkSecretKey: required.CLERK_SECRET_KEY,
    tunnelNamePrefix: read("TUNNEL_NAME_PREFIX") || "relay",
    maxInstancesPerUser: Number.isInteger(maxInstances) && maxInstances > 0 ? maxInstances : 5,
  };
}

/**
 * Clerk publishable keys are `pk_test_` or `pk_live_` followed by the
 * base64 Frontend API host and a trailing `$`.
 */
export function clerkFrontendApi(publishableKey: string): string | null {
  const encoded = publishableKey.replace(/^pk_(?:test|live)_/u, "");
  if (encoded === publishableKey) {
    return null;
  }
  try {
    const decoded = atob(encoded);
    return decoded.endsWith("$") && decoded.length > 1 ? decoded.slice(0, -1) : null;
  } catch {
    return null;
  }
}
