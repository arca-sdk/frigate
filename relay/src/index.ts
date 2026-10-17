/** Worker entry point: wires the relay's dependencies from its bindings. */

import { type Dependencies, handleApiRequest, runMaintenance } from "./app.ts";
import { createClerkAuthenticator, createClerkDirectory } from "./auth.ts";
import { createCloudflareApi } from "./cloudflare.ts";
import { type RelayEnv, RelayNotConfiguredError, loadConfig } from "./config.ts";
import { errorResponse, HttpError } from "./http.ts";
import { Store } from "./store.ts";

function dependencies(env: RelayEnv): Dependencies {
  const config = loadConfig(env);
  return {
    config,
    store: new Store(env.DB),
    cloudflare: createCloudflareApi({
      accountId: config.cloudflareAccountId,
      zoneId: config.cloudflareZoneId,
      apiToken: config.cloudflareApiToken,
    }),
    users: createClerkAuthenticator({ secretKey: config.clerkSecretKey, publicUrl: config.publicUrl }),
    accounts: createClerkDirectory(config.clerkSecretKey),
    linkRateLimiter: env.LINK_RATE_LIMITER,
    codeRateLimiter: env.CODE_RATE_LIMITER,
    now: () => Date.now(),
  };
}

export default {
  async fetch(request, env) {
    // Static pages are served from public/ before the Worker runs; only the
    // API and unknown paths reach this point.
    if (!new URL(request.url).pathname.startsWith("/v1/")) {
      return errorResponse(new HttpError(404, "not_found"));
    }
    let deps: Dependencies;
    try {
      deps = dependencies(env);
    } catch (error) {
      if (error instanceof RelayNotConfiguredError) {
        console.error(error.message);
        return errorResponse(new HttpError(503, "relay_not_configured", "This relay is not set up yet"));
      }
      throw error;
    }
    return handleApiRequest(request, deps);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMaintenance(dependencies(env)));
  },
} satisfies ExportedHandler<RelayEnv>;
