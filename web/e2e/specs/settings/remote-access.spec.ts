/**
 * Remote access settings page tests -- MEDIUM tier.
 *
 * Drives the Connect link flow and the Tailscale sign-in against a mocked
 * /api/remote_access that changes state the way the backend does.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { Page } from "@playwright/test";

type Status = {
  connect: Record<string, unknown>;
  tailscale: Record<string, unknown>;
  security: { auth_enabled: boolean; login_rate_limit_enabled: boolean };
  origin: { scheme: string; host: string; port: number };
};

const VERIFICATION_URL = "https://relay.example.com/link?code=BCDF-GHJK";
const CONNECT_URL = "https://k3m9x2p4q7r8s5t6.tunnels.example.net/";
const TAILNET_URL = "https://frigate.tail1234.ts.net/";

function baseStatus(): Status {
  return {
    connect: {
      available: true,
      unavailable_reason: null,
      blocked_reason: null,
      dashboard_url: "https://relay.example.com/",
      state: "unlinked",
      link: null,
      name: null,
      hostname: null,
      url: null,
      account_label: null,
      linked_at: null,
      connector: { state: "stopped", connections: 0, error: null },
      relay_error: null,
      error: null,
    },
    tailscale: {
      available: true,
      enabled: false,
      state: "off",
      auth_url: null,
      dns_name: null,
      tailnet: null,
      url: null,
      serve: "off",
      enable_https_url: null,
      error: null,
    },
    security: { auth_enabled: true, login_rate_limit_enabled: true },
    origin: { scheme: "https", host: "127.0.0.1", port: 8971 },
  };
}

function linked(status: Status): Status {
  return {
    ...status,
    connect: {
      ...status.connect,
      state: "linked",
      link: null,
      name: "Garage",
      hostname: "k3m9x2p4q7r8s5t6.tunnels.example.net",
      url: CONNECT_URL,
      account_label: "alice@example.com",
      connector: { state: "connected", connections: 4, error: null },
    },
  };
}

/** The settings page loads raw config paths, which no default mock answers. */
async function installRawPaths(page: Page) {
  await page.route("**/api/config/raw_paths", (route) =>
    route.fulfill({ json: { cameras: {} } }),
  );
}

/** A stateful stand-in for the backend's remote access routes. */
async function installRemoteAccess(page: Page, initial: Status) {
  await installRawPaths(page);
  let status = initial;
  const requests: string[] = [];
  await page.route("**/api/remote_access**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\//, "");
    requests.push(`${request.method()} ${path}`);
    if (request.method() === "POST" && path === "remote_access/connect/link") {
      status = {
        ...status,
        connect: {
          ...status.connect,
          state: "linking",
          link: {
            user_code: "BCDF-GHJK",
            verification_url: "https://relay.example.com/link",
            verification_url_complete: VERIFICATION_URL,
            expires_at: Date.now() / 1000 + 600,
          },
        },
      };
    } else if (
      request.method() === "DELETE" &&
      path === "remote_access/connect"
    ) {
      status = baseStatus();
    } else if (path === "remote_access/tailscale/enable") {
      status = {
        ...status,
        tailscale: {
          ...status.tailscale,
          enabled: true,
          state: "needs_login",
          auth_url: "https://login.tailscale.com/a/abc123",
        },
      };
    }
    await route.fulfill({ json: status });
  });
  return {
    requests,
    set(next: (current: Status) => Status) {
      status = next(status);
    },
  };
}

test.describe("Remote access settings @medium", () => {
  test("links Connect with a code and then shows the address", async ({
    frigateApp,
  }) => {
    const backend = await installRemoteAccess(frigateApp.page, baseStatus());
    await frigateApp.goto("/settings?page=remoteAccess");
    const page = frigateApp.page;

    await page.getByLabel("Name for this Frigate").fill("Garage");
    await page.getByRole("button", { name: "Set up" }).click();

    await expect(page.getByTestId("remote-access-code")).toHaveText(
      "BCDF-GHJK",
    );
    await expect(
      page.getByRole("link", { name: "Open sign-in page" }),
    ).toHaveAttribute("href", VERIFICATION_URL);
    await expect(page.getByText(/The code expires in 9:5\d/)).toBeVisible();

    backend.set(linked);
    await expect(page.getByRole("link", { name: CONNECT_URL })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Linked as Garage to alice@example.com"),
    ).toBeVisible();
    expect(backend.requests).toContain("POST remote_access/connect/link");
  });

  test("asks before turning Connect off", async ({ frigateApp }) => {
    const backend = await installRemoteAccess(
      frigateApp.page,
      linked(baseStatus()),
    );
    await frigateApp.goto("/settings?page=remoteAccess");
    const page = frigateApp.page;

    await page.getByRole("button", { name: "Turn off" }).first().click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "k3m9x2p4q7r8s5t6.tunnels.example.net stops working",
    );
    await dialog.getByRole("button", { name: "Turn off" }).click();

    await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
    expect(backend.requests).toContain("DELETE remote_access/connect");
  });

  test("blocks Connect while authentication is off", async ({ frigateApp }) => {
    const status = baseStatus();
    status.security.auth_enabled = false;
    status.connect.blocked_reason = "auth_disabled";
    await installRemoteAccess(frigateApp.page, status);
    await frigateApp.goto("/settings?page=remoteAccess");

    await expect(
      frigateApp.page.getByText("Authentication is turned off"),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByRole("button", { name: "Set up" }),
    ).toBeDisabled();
  });

  test("warns when failed login rate limiting is off", async ({
    frigateApp,
  }) => {
    const status = baseStatus();
    status.security.login_rate_limit_enabled = false;
    await installRemoteAccess(frigateApp.page, status);
    await frigateApp.goto("/settings?page=remoteAccess");

    await expect(
      frigateApp.page.getByText("Failed login rate limiting is off"),
    ).toBeVisible();
  });

  test("signs in to Tailscale and shows the tailnet address @mobile", async ({
    frigateApp,
  }) => {
    const backend = await installRemoteAccess(frigateApp.page, baseStatus());
    await frigateApp.goto("/settings?page=remoteAccess");
    const page = frigateApp.page;

    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(
      page.getByRole("link", { name: "Sign in to Tailscale" }),
    ).toHaveAttribute("href", "https://login.tailscale.com/a/abc123");

    backend.set((current) => ({
      ...current,
      tailscale: {
        ...current.tailscale,
        state: "running",
        auth_url: null,
        dns_name: "frigate.tail1234.ts.net",
        tailnet: "example.com",
        url: TAILNET_URL,
        serve: "on",
      },
    }));
    await expect(page.getByRole("link", { name: TAILNET_URL })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Shared on example.com")).toBeVisible();
  });
});

test.describe("Remote access settings when the status fails @medium", () => {
  // The failed status request is the point of this test.
  test.use({ expectedErrors: [/remote_access|status of 500/] });

  test("shows an error with a retry instead of loading forever", async ({
    frigateApp,
  }) => {
    let fail = true;
    await installRawPaths(frigateApp.page);
    await frigateApp.page.route("**/api/remote_access", async (route) => {
      if (fail) {
        await route.fulfill({ status: 500, json: { success: false } });
      } else {
        await route.fulfill({ json: baseStatus() });
      }
    });
    await frigateApp.goto("/settings?page=remoteAccess");
    const page = frigateApp.page;

    await expect(
      page.getByText("Could not load the remote access status."),
    ).toBeVisible({ timeout: 10_000 });
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
  });
});
