/** Entry point: the server list window, its IPC handlers and the app menu. */

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";

import { strings } from "../shared/strings";
import {
  IPC,
  type AddServerRequest,
  type AddServerResult,
  type ServerProblem,
  type ServerRecord,
  type ServerView,
} from "../shared/types";
import { probeServer, type ProbeResult } from "./probe";
import { ServerStore } from "./serverStore";
import { bareHostname, isExternalLink, parseServerUrl } from "./serverUrl";
import { ServerWindows } from "./serverWindows";

// Lets the end-to-end tests run against a throwaway profile.
if (process.env.FRIGATE_DESKTOP_USER_DATA) {
  app.setPath("userData", process.env.FRIGATE_DESKTOP_USER_DATA);
}

const store = new ServerStore(
  path.join(app.getPath("userData"), "servers.json"),
);
const problems = new Map<string, ServerProblem>();
const serverWindows = new ServerWindows(store, reportProblem);
/** Servers being checked before their window opens. */
const opening = new Set<string>();
const SLOW_CHECK_MS = 1000;
let listWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.enableSandbox();
  app.on("second-instance", showServerList);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showServerList();
    }
  });

  void app.whenReady().then(() => {
    store.load();
    registerIpc();
    Menu.setApplicationMenu(buildMenu());

    // With a single server, go straight to it; the list stays in the menu.
    const servers = store.list();

    if (servers.length === 1) {
      void openServer(servers[0]);
    } else {
      showServerList();
    }
  });
}

function showServerList(): void {
  if (listWindow) {
    if (listWindow.isMinimized()) {
      listWindow.restore();
    }
    listWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 400,
    minHeight: 400,
    title: strings.list.title,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  // The list is a local page; it never navigates or opens windows.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });
  window.on("closed", () => {
    listWindow = null;
  });

  listWindow = window;
  void window.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function buildMenu(): Menu {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as const] : []),
    {
      label: strings.menu.file,
      submenu: [
        {
          label: strings.menu.servers,
          accelerator: "CmdOrCtrl+Shift+S",
          click: showServerList,
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  return Menu.buildFromTemplate(template);
}

function toView(server: ServerRecord): ServerView {
  return {
    ...server,
    encrypted: server.url.startsWith("https:"),
    checking: opening.has(server.id),
    problem: problems.get(server.id) ?? null,
  };
}

function broadcast(): void {
  listWindow?.webContents.send(IPC.changed, store.list().map(toView));
}

function reportProblem(serverId: string, problem: ServerProblem | null): void {
  if (problem) {
    problems.set(serverId, problem);
  } else if (!problems.delete(serverId)) {
    return;
  }

  broadcast();

  if (problem) {
    showServerList();
  }
}

/** Only the server list page may call these. */
function fromServerList(event: IpcMainInvokeEvent): boolean {
  return listWindow !== null && event.sender === listWindow.webContents;
}

function registerIpc(): void {
  ipcMain.handle(IPC.list, (event) =>
    fromServerList(event) ? store.list().map(toView) : [],
  );

  ipcMain.handle(IPC.add, async (event, request: unknown) => {
    if (!fromServerList(event) || !isAddServerRequest(request)) {
      return {
        kind: "rejected",
        reason: "invalid_url",
      } satisfies AddServerResult;
    }
    return addServer(request);
  });

  ipcMain.handle(IPC.open, async (event, id: unknown) => {
    const server = typeof id === "string" ? store.get(id) : undefined;

    if (fromServerList(event) && server) {
      await openServer(server);
    }
  });

  ipcMain.handle(IPC.remove, async (event, id: unknown) => {
    if (!fromServerList(event) || typeof id !== "string" || !store.get(id)) {
      return;
    }

    await serverWindows.forget(id);
    store.remove(id);
    problems.delete(id);
    broadcast();
  });

  ipcMain.handle(
    IPC.trustCertificate,
    async (event, id: unknown, fingerprint: unknown) => {
      const server = typeof id === "string" ? store.get(id) : undefined;
      const problem = server && problems.get(server.id);

      // Only the certificate the server actually presented can be trusted.
      if (
        !fromServerList(event) ||
        !server ||
        (problem?.kind !== "untrusted_certificate" &&
          problem?.kind !== "certificate_changed") ||
        problem.certificate.fingerprint !== fingerprint
      ) {
        return;
      }

      store.update(server.id, {
        certificateFingerprint: problem.certificate.fingerprint,
      });

      if (
        serverWindows.hasRejected(server.id, problem.certificate.fingerprint)
      ) {
        reportProblem(server.id, { kind: "restart_required" });
        return;
      }

      reportProblem(server.id, null);
      await openServer({
        ...server,
        certificateFingerprint: problem.certificate.fingerprint,
      });
    },
  );

  ipcMain.handle(IPC.restart, (event) => {
    if (fromServerList(event)) {
      app.relaunch();
      app.exit(0);
    }
  });
}

/**
 * Open a window on a saved server, after checking it in a throwaway session.
 *
 * Checking first keeps a changed certificate away from the server's own
 * session: once that session rejects a certificate, Chromium won't accept it
 * there until the app restarts, even after the user trusts it.
 */
async function openServer(server: ServerRecord): Promise<void> {
  if (serverWindows.focusExisting(server.id) || opening.has(server.id)) {
    return;
  }

  opening.add(server.id);
  broadcast();
  // At startup nothing is on screen yet, so show progress if the check is slow.
  const slow = setTimeout(showServerList, SLOW_CHECK_MS);

  let probe: ProbeResult;

  try {
    probe = await probeServer(
      server.url,
      bareHostname(new URL(server.url).hostname),
      server.certificateFingerprint,
    );
  } finally {
    clearTimeout(slow);
    opening.delete(server.id);
    broadcast();
  }

  switch (probe.kind) {
    case "ok": {
      // Removed while it was being checked.
      if (!store.get(server.id)) {
        return;
      }

      // Follow the server: auth may have been turned on or off, and a pin
      // isn't needed once the system trusts the certificate.
      const changes = {
        loginRequired: probe.loginRequired,
        certificateFingerprint: probe.pinnedFingerprint,
      };
      store.update(server.id, changes);
      reportProblem(server.id, null);
      broadcast();
      serverWindows.open({ ...server, ...changes });
      break;
    }
    case "untrusted_certificate":
      reportProblem(
        server.id,
        server.certificateFingerprint
          ? { kind: "certificate_changed", certificate: probe.certificate }
          : probe,
      );
      break;
    default:
      reportProblem(server.id, probe);
  }
}

async function addServer(request: AddServerRequest): Promise<AddServerResult> {
  const parsed = parseServerUrl(request.url);

  if (!parsed.ok) {
    return { kind: "rejected", reason: parsed.reason };
  }

  if (store.findByUrl(parsed.url)) {
    return { kind: "rejected", reason: "duplicate" };
  }

  const probe = await probeServer(
    parsed.url,
    parsed.hostname,
    request.trustedFingerprint ?? null,
  );

  if (probe.kind !== "ok") {
    return probe;
  }

  // Checked again because the probe awaited.
  if (store.findByUrl(parsed.url)) {
    return { kind: "rejected", reason: "duplicate" };
  }

  const server: ServerRecord = {
    id: randomUUID(),
    name: request.name.trim() || parsed.hostname,
    url: parsed.url,
    certificateFingerprint: probe.pinnedFingerprint,
    loginRequired: probe.loginRequired,
  };

  store.add(server);
  broadcast();
  // Just checked, so there's no need for openServer's check.
  serverWindows.open(server);

  return { kind: "added", server: toView(server) };
}

function isAddServerRequest(value: unknown): value is AddServerRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const request = value as Record<string, unknown>;

  return (
    typeof request.url === "string" &&
    typeof request.name === "string" &&
    (request.trustedFingerprint === undefined ||
      typeof request.trustedFingerprint === "string")
  );
}
