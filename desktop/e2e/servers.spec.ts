import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { strings } from "../src/shared/strings";
import { FakeFrigate, type FakeFrigateMode } from "./fakeFrigate";

const appDirectory = path.join(__dirname, "..");

let userData: string;
let app: ElectronApplication | null = null;
const servers: FakeFrigate[] = [];

async function launch(): Promise<ElectronApplication> {
  const env: Record<string, string> = { FRIGATE_DESKTOP_USER_DATA: userData };

  for (const [key, value] of Object.entries(process.env)) {
    // Set when the tests themselves run under an Electron-based tool.
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") {
      env[key] ??= value;
    }
  }

  app = await electron.launch({ args: [appDirectory], env });

  // Record links handed to the system browser instead of opening them.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedExternally: opened });
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });

  return app;
}

async function startFrigate(
  mode: FakeFrigateMode = "auth",
): Promise<FakeFrigate> {
  const frigate = new FakeFrigate(mode);
  servers.push(frigate);
  await frigate.start();
  return frigate;
}

function savedServers(): Array<Record<string, unknown>> {
  const file = path.join(userData, "servers.json");
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8")).servers
    : [];
}

async function submitServer(
  list: Page,
  address: string,
  name = "",
): Promise<void> {
  await list.getByLabel(strings.add.urlLabel).fill(address);
  await list.getByLabel(strings.add.nameLabel).fill(name);
  await list.getByRole("button", { name: strings.add.submit }).click();
}

/** Add a server with a self-signed certificate and return its window. */
async function addTrustedServer(
  electronApp: ElectronApplication,
  list: Page,
  frigate: FakeFrigate,
  name: string,
): Promise<Page> {
  await submitServer(list, frigate.address, name);
  await expect(list.locator("#add-certificate .fingerprint")).toHaveText(
    frigate.fingerprint,
  );

  const opened = electronApp.waitForEvent("window");
  await list.getByRole("button", { name: strings.certificate.trust }).click();
  const serverPage = await opened;
  await expect(
    serverPage.getByRole("heading", { name: "Fake Frigate" }),
  ).toBeVisible();

  return serverPage;
}

test.beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "frigate-desktop-e2e-"));
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  await Promise.all(servers.splice(0).map((frigate) => frigate.dispose()));
  fs.rmSync(userData, { recursive: true, force: true });
});

test("adds a server after its self-signed certificate is trusted", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();

  const serverPage = await addTrustedServer(electronApp, list, frigate, "Home");

  await expect(serverPage).toHaveURL(`https://${frigate.address}/`);
  await expect(list.locator("li.server")).toHaveCount(1);
  await expect(list.locator("li.server .server-name")).toHaveText("Home");
  await expect(list.locator("li.server")).toContainText(
    strings.list.trustedCertificate,
  );
  await expect(list.locator("li.server")).not.toContainText(
    strings.list.noLogin,
  );
  await expect(list.getByLabel(strings.add.urlLabel)).toHaveValue("");

  expect(savedServers()).toEqual([
    expect.objectContaining({
      name: "Home",
      url: `https://${frigate.address}/`,
      loginRequired: true,
      certificateFingerprint: expect.stringMatching(/^sha256\//),
    }),
  ]);
});

test("reopens the only server directly, with its certificate still trusted", async () => {
  const frigate = await startFrigate();
  let electronApp = await launch();
  await addTrustedServer(
    electronApp,
    await electronApp.firstWindow(),
    frigate,
    "Home",
  );
  await electronApp.close();

  electronApp = await launch();
  const first = await electronApp.firstWindow();

  await expect(
    first.getByRole("heading", { name: "Fake Frigate" }),
  ).toBeVisible();
  await expect(first).toHaveURL(`https://${frigate.address}/`);
});

test("shows the list when the only server is slow to answer at startup", async () => {
  const frigate = await startFrigate();
  let electronApp = await launch();
  await addTrustedServer(
    electronApp,
    await electronApp.firstWindow(),
    frigate,
    "Home",
  );
  await electronApp.close();

  // Accept connections but never answer, like a host that has hung.
  await frigate.stop();
  const hung = net.createServer(() => undefined);
  await new Promise<void>((resolve) =>
    hung.listen(frigate.port, "127.0.0.1", resolve),
  );

  try {
    electronApp = await launch();
    const list = await electronApp.firstWindow();
    const open = list.locator("li.server").getByRole("button").first();

    await expect(open).toHaveText(strings.list.connecting);
    await expect(open).toBeDisabled();
    await expect(list.locator("li.server .error")).toHaveText(
      strings.unreachable("timed out"),
      { timeout: 15_000 },
    );
    await expect(open).toHaveText(strings.list.open);
  } finally {
    hung.close();
  }
});

test("cancelling the certificate prompt saves nothing", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();

  await submitServer(list, frigate.address);
  await list.getByRole("button", { name: strings.certificate.cancel }).click();

  await expect(list.locator("#add-certificate")).toBeEmpty();
  await expect(list.locator("li.server")).toHaveCount(0);
  expect(savedServers()).toEqual([]);
});

test("refuses the internal port by number and by asking the server", async () => {
  const frigate = await startFrigate("internal");
  const electronApp = await launch();
  const list = await electronApp.firstWindow();

  await submitServer(list, "frigate.local:5000");
  await expect(list.locator("#add-error")).toHaveText(
    strings.rejections.internal_port,
  );

  // The internal port can be moved, so the server's answer decides too.
  await submitServer(list, frigate.address);
  await list.getByRole("button", { name: strings.certificate.trust }).click();
  await expect(list.locator("#add-error")).toHaveText(
    strings.rejections.internal_port,
  );
  expect(savedServers()).toEqual([]);
});

test("refuses something that isn't Frigate", async () => {
  const other = await startFrigate("not_frigate");
  const electronApp = await launch();
  const list = await electronApp.firstWindow();

  await submitServer(list, other.address);
  await list.getByRole("button", { name: strings.certificate.trust }).click();

  await expect(list.locator("#add-error")).toHaveText(
    strings.rejections.not_frigate,
  );
});

test("reports a server that can't be reached", async () => {
  const frigate = await startFrigate();
  const address = frigate.address;
  await frigate.stop();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();

  await submitServer(list, address);

  await expect(list.locator("#add-error")).toContainText(
    "ERR_CONNECTION_REFUSED",
  );
});

test("suggests the address a server redirects to", async () => {
  const frigate = await startFrigate();
  // A plain HTTP listener that sends everything to the HTTPS server, as a
  // reverse proxy does.
  const redirector = http.createServer((request, response) => {
    response.writeHead(301, {
      Location: `https://${frigate.address}${request.url}`,
    });
    response.end();
  });
  await new Promise<void>((resolve) =>
    redirector.listen(0, "127.0.0.1", resolve),
  );
  const { port } = redirector.address() as AddressInfo;

  try {
    const electronApp = await launch();
    const list = await electronApp.firstWindow();

    await submitServer(list, `http://127.0.0.1:${port}`);

    await expect(list.locator("#add-error")).toHaveText(
      strings.redirected(`https://${frigate.address}/`),
    );
    expect(savedServers()).toEqual([]);
  } finally {
    redirector.close();
  }
});

test("marks a server that doesn't require sign-in", async () => {
  const frigate = await startFrigate("open");
  const electronApp = await launch();
  const list = await electronApp.firstWindow();

  await addTrustedServer(electronApp, list, frigate, "Open");

  await expect(list.locator("li.server")).toContainText(strings.list.noLogin);
});

test("stops at a changed certificate until the new one is trusted", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();
  const serverPage = await addTrustedServer(electronApp, list, frigate, "Home");
  await serverPage.close();

  await frigate.restartWithNewCertificate();
  await list.getByRole("button", { name: strings.list.open }).click();

  const item = list.locator("li.server");
  await expect(item.locator(".certificate.changed")).toContainText(
    strings.certificate.changedTitle,
  );
  await expect(item.locator(".fingerprint")).toHaveText(frigate.fingerprint);
  // Checked before opening, so no window ever tried the new certificate.
  expect(electronApp.windows()).toHaveLength(1);

  const reopened = electronApp.waitForEvent("window");
  await item.getByRole("button", { name: strings.certificate.trust }).click();
  await expect(
    (await reopened).getByRole("heading", { name: "Fake Frigate" }),
  ).toBeVisible();
  await expect(item.locator(".certificate")).toHaveCount(0);
});

test("asks for a restart when an open window already turned the certificate down", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();
  const serverPage = await addTrustedServer(electronApp, list, frigate, "Home");

  await frigate.restartWithNewCertificate();
  // The window reloads, fails on the new certificate and closes.
  await serverPage.reload().catch(() => undefined);

  const item = list.locator("li.server");
  await expect(item.locator(".certificate.changed .fingerprint")).toHaveText(
    frigate.fingerprint,
  );
  await item.getByRole("button", { name: strings.certificate.trust }).click();

  await expect(item).toContainText(strings.certificate.restartRequired);
  await expect(
    item.getByRole("button", { name: strings.certificate.restart }),
  ).toBeVisible();
  expect(electronApp.windows()).toHaveLength(1);
});

test("reports a saved server that has gone away", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();
  const serverPage = await addTrustedServer(electronApp, list, frigate, "Home");
  await serverPage.close();

  await frigate.stop();
  await list.getByRole("button", { name: strings.list.open }).click();

  await expect(list.locator("li.server .error")).toContainText(
    "ERR_CONNECTION_REFUSED",
  );
  expect(electronApp.windows()).toHaveLength(1);
});

test("keeps server windows on the server", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();
  const serverPage = await addTrustedServer(electronApp, list, frigate, "Home");

  // A page the UI opens in a new tab gets its own window on the server.
  const opened = electronApp.waitForEvent("window");
  await serverPage.locator("#new-tab").click();
  await expect(await opened).toHaveURL(`https://${frigate.address}/review`);

  // Links elsewhere go to the system browser. Playwright's click() would
  // wait for the navigation the app blocks, and then treat it as pending, so
  // the page is driven and read from inside.
  await serverPage.evaluate(() => document.getElementById("external")?.click());
  await expect
    .poll(() =>
      electronApp.evaluate(
        () => (globalThis as { openedExternally?: string[] }).openedExternally,
      ),
    )
    .toEqual(["https://example.com/"]);
  expect(await serverPage.evaluate(() => location.href)).toBe(
    `https://${frigate.address}/`,
  );
});

test("gives server pages only the permissions the UI needs", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();
  const serverPage = await addTrustedServer(electronApp, list, frigate, "Home");

  // Web push can't work in Electron, so the UI shouldn't be told it might.
  expect(
    await serverPage.evaluate(() => Notification.requestPermission()),
  ).toBe("denied");
  expect(
    await serverPage.evaluate(() =>
      navigator.permissions
        .query({ name: "geolocation" })
        .then((status) => status.state),
    ),
  ).toBe("denied");
});

test("removing a server forgets it", async () => {
  const frigate = await startFrigate();
  const electronApp = await launch();
  const list = await electronApp.firstWindow();
  await addTrustedServer(electronApp, list, frigate, "Home");

  list.once("dialog", (dialog) => void dialog.accept());
  await list.getByRole("button", { name: strings.list.remove }).click();

  await expect(list.locator("li.server")).toHaveCount(0);
  await expect(list.locator("#empty")).toBeVisible();
  expect(savedServers()).toEqual([]);
  expect(electronApp.windows()).toHaveLength(1);
});
