import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Each test launches its own app; running them one at a time keeps the
  // windows from competing for focus.
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
