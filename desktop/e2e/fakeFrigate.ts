/**
 * A stand-in Frigate for the end-to-end tests: HTTPS with a self-signed
 * certificate made the way Frigate makes its own, and just the endpoints the
 * app checks when adding a server.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * How the server answers a signed-out GET api/profile: "auth" like port 8971
 * with auth on, "internal" like port 5000, "open" like 8971 with auth off.
 */
export type FakeFrigateMode = "auth" | "internal" | "open" | "not_frigate";

const PAGE = `<!doctype html>
<html>
  <head><title>Frigate</title></head>
  <body>
    <h1>Fake Frigate</h1>
    <a id="external" href="https://example.com/">Docs</a>
    <a id="new-tab" href="/review" target="_blank">Review</a>
  </body>
</html>`;

export class FakeFrigate {
  private server: https.Server | null = null;
  private certificateDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fake-frigate-"),
  );
  port = 0;
  /** The certificate's SHA-256 fingerprint as openssl prints it. */
  fingerprint = "";

  constructor(private readonly mode: FakeFrigateMode = "auth") {}

  get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** Start on a free port, or on the previous one after `stop`. */
  async start(): Promise<void> {
    const { key, cert } = this.createCertificate();
    const server = https.createServer({ key, cert }, (request, response) =>
      this.handle(request.url ?? "/", response),
    );

    await new Promise<void>((resolve) =>
      server.listen(this.port, "127.0.0.1", resolve),
    );
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;

    if (!server) {
      return;
    }

    this.server = null;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  /** Come back on the same port with a new certificate, as after deleting Frigate's. */
  async restartWithNewCertificate(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async dispose(): Promise<void> {
    await this.stop();
    fs.rmSync(this.certificateDirectory, { recursive: true, force: true });
  }

  private createCertificate(): { key: Buffer; cert: Buffer } {
    const keyFile = path.join(this.certificateDirectory, "privkey.pem");
    const certificateFile = path.join(
      this.certificateDirectory,
      "fullchain.pem",
    );

    // Same subject as the certificate Frigate generates on first start.
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-days",
        "365",
        "-nodes",
        "-x509",
        "-subj",
        "/O=FRIGATE DEFAULT CERT/CN=*",
        "-keyout",
        keyFile,
        "-out",
        certificateFile,
      ],
      { stdio: "ignore" },
    );

    const output = execFileSync(
      "openssl",
      ["x509", "-noout", "-fingerprint", "-sha256", "-in", certificateFile],
      { encoding: "utf8" },
    );
    this.fingerprint = output.trim().split("=")[1];

    return {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certificateFile),
    };
  }

  private handle(
    url: string,
    response: import("node:http").ServerResponse,
  ): void {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (this.mode === "not_frigate") {
      response.writeHead(404);
      response.end();
      return;
    }

    if (url === "/api/auth/first_time_login") {
      json(200, { admin_first_time_login: false });
    } else if (url === "/api/profile") {
      if (this.mode === "auth") {
        json(401, { detail: "Authentication required" });
      } else if (this.mode === "internal") {
        json(200, {
          username: "anonymous",
          role: "admin",
          allowed_cameras: [],
        });
      } else {
        json(200, { username: "viewer", role: "admin", allowed_cameras: [] });
      }
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(PAGE);
    }
  }
}
