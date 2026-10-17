import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);

// Storage persists between tests in a file, so start each one empty.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM link_requests"), env.DB.prepare("DELETE FROM instances")]);
});
