/** Windows that show a server's own Frigate UI. */

import { BrowserWindow, session, shell } from "electron";

import type {
  CertificateInfo,
  ServerProblem,
  ServerRecord,
} from "../shared/types";
import {
  ACCEPT_CERTIFICATE,
  isCertificateError,
  toCertificateInfo,
  verifyCertificate,
} from "./certificates";
import { isPermissionAllowed } from "./permissions";
import { ServerStore } from "./serverStore";
import { bareHostname, isExternalLink, isSameOrigin } from "./serverUrl";

/** Chromium's net::ERR_ABORTED, reported when a navigation is replaced by another. */
const ERR_ABORTED = -3;

/** Each server gets its own persistent session, so sign-ins never mix. */
export function partitionFor(serverId: string): string {
  return `persist:server-${serverId}`;
}

export class ServerWindows {
  private readonly windows = new Map<string, Set<BrowserWindow>>();
  private readonly configuredSessions = new Set<string>();
  private readonly rejectedCertificates = new Map<string, CertificateInfo>();
  private readonly rejectedFingerprints = new Map<string, Set<string>>();

  constructor(
    private readonly store: ServerStore,
    private readonly reportProblem: (
      serverId: string,
      problem: ServerProblem | null,
    ) => void,
  ) {}

  /** Open a window on the server, at its base URL or at a page on the same origin. */
  open(server: ServerRecord, url: string = server.url): BrowserWindow {
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 480,
      minHeight: 360,
      title: server.name,
      autoHideMenuBar: true,
      webPreferences: {
        session: this.sessionFor(server),
        // The page is the server's, so it gets no preload and no Node.js.
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
      },
    });

    this.track(server.id, window);
    this.guard(server.id, window);
    // A failed load is reported by the did-fail-load handler in guard().
    window.loadURL(url).catch(() => undefined);

    return window;
  }

  /** Focus a window already showing the server. False if there is none. */
  focusExisting(serverId: string): boolean {
    const existing = this.windows.get(serverId)?.values().next().value;

    if (!existing) {
      return false;
    }

    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
    return true;
  }

  /**
   * True if the server's session has turned this certificate down. Chromium
   * caches that per session until the app restarts, and changing the verify
   * proc doesn't clear it, so trusting the certificate can't take effect
   * before then.
   */
  hasRejected(serverId: string, fingerprint: string): boolean {
    return this.rejectedFingerprints.get(serverId)?.has(fingerprint) ?? false;
  }

  /** Close the server's windows and delete everything its session stored. */
  async forget(serverId: string): Promise<void> {
    this.closeAll(serverId);
    this.rejectedCertificates.delete(serverId);
    this.rejectedFingerprints.delete(serverId);
    await session.fromPartition(partitionFor(serverId)).clearData();
  }

  private closeAll(serverId: string): void {
    for (const window of this.windows.get(serverId) ?? []) {
      window.destroy();
    }
  }

  private track(serverId: string, window: BrowserWindow): void {
    const open = this.windows.get(serverId) ?? new Set();
    open.add(window);
    this.windows.set(serverId, open);

    window.on("closed", () => {
      open.delete(window);
    });
  }

  private sessionFor(server: ServerRecord): Electron.Session {
    const serverSession = session.fromPartition(partitionFor(server.id));

    if (this.configuredSessions.has(server.id)) {
      return serverSession;
    }

    this.installVerifyProc(serverSession, server.id);

    serverSession.setPermissionRequestHandler(
      (_contents, permission, callback, details) => {
        const mediaTypes =
          "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
        callback(
          isPermissionAllowed(
            permission,
            details.requestingUrl,
            server.url,
            mediaTypes,
          ),
        );
      },
    );

    serverSession.setPermissionCheckHandler(
      (_contents, permission, requestingOrigin, details) =>
        isPermissionAllowed(
          permission,
          requestingOrigin,
          server.url,
          details.mediaType ? [details.mediaType] : [],
        ),
    );

    this.configuredSessions.add(server.id);

    return serverSession;
  }

  /**
   * Accept the server's pinned certificate, and remember rejected ones so a
   * failed load can show them to the user.
   */
  private installVerifyProc(
    serverSession: Electron.Session,
    serverId: string,
  ): void {
    serverSession.setCertificateVerifyProc((request, callback) => {
      const server = this.store.get(serverId);

      if (!server) {
        callback(verifyCertificate(request, "", null));
        return;
      }

      const hostname = bareHostname(new URL(server.url).hostname);
      const result = verifyCertificate(
        request,
        hostname,
        server.certificateFingerprint,
      );

      if (
        request.errorCode !== 0 &&
        result !== ACCEPT_CERTIFICATE &&
        bareHostname(request.hostname) === hostname
      ) {
        const rejected = this.rejectedFingerprints.get(serverId) ?? new Set();
        rejected.add(request.certificate.fingerprint);
        this.rejectedFingerprints.set(serverId, rejected);
        this.rejectedCertificates.set(
          serverId,
          toCertificateInfo(request.certificate),
        );
      }

      callback(result);
    });
  }

  /**
   * Keep the window on the server's origin. Links elsewhere open in the
   * system browser, and pages the UI opens in a new tab get their own window.
   */
  private guard(serverId: string, window: BrowserWindow): void {
    const contents = window.webContents;
    const server = (): ServerRecord | undefined => this.store.get(serverId);

    const keepOnServer = (
      event: Electron.Event<{ url: string; isMainFrame: boolean }>,
    ) => {
      const current = server();

      if (
        event.isMainFrame &&
        (!current || !isSameOrigin(event.url, current.url))
      ) {
        event.preventDefault();
        openExternally(event.url);
      }
    };

    contents.on("will-navigate", keepOnServer);
    contents.on("will-redirect", keepOnServer);

    contents.setWindowOpenHandler(({ url }) => {
      const current = server();

      if (current && isSameOrigin(url, current.url)) {
        this.open(current, url);
      } else {
        openExternally(url);
      }

      return { action: "deny" };
    });

    window.on("page-title-updated", (event, title) => {
      const current = server();

      if (current) {
        event.preventDefault();
        window.setTitle(`${current.name} - ${title}`);
      }
    });

    contents.on("did-finish-load", () => {
      this.rejectedCertificates.delete(serverId);
      this.reportProblem(serverId, null);
    });

    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) {
          return;
        }

        this.reportProblem(
          serverId,
          this.describeFailure(serverId, errorCode, errorDescription),
        );
        window.destroy();
      },
    );
  }

  private describeFailure(
    serverId: string,
    errorCode: number,
    errorDescription: string,
  ): ServerProblem {
    const certificate = this.rejectedCertificates.get(serverId);

    if (isCertificateError(errorCode) && certificate) {
      return this.store.get(serverId)?.certificateFingerprint
        ? { kind: "certificate_changed", certificate }
        : { kind: "untrusted_certificate", certificate };
    }

    return { kind: "unreachable", error: errorDescription };
  }
}

function openExternally(url: string): void {
  if (isExternalLink(url)) {
    // Fails when nothing handles the link; there's nothing more to do then.
    shell.openExternal(url).catch(() => undefined);
  }
}
