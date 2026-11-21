import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerStore } from "../src/main/serverStore";
import type { ServerRecord } from "../src/shared/types";

const server: ServerRecord = {
  id: "a",
  name: "Home",
  url: "https://frigate.local:8971/",
  certificateFingerprint: "sha256/pinned",
  loginRequired: true,
};

describe("ServerStore", () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "frigate-desktop-"));
    file = path.join(directory, "servers.json");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("starts empty without a file", () => {
    const store = new ServerStore(file);
    store.load();

    expect(store.list()).toEqual([]);
  });

  it("saves servers and reads them back", () => {
    const store = new ServerStore(file);
    store.load();
    store.add(server);
    store.update("a", { name: "Garage" });

    const reloaded = new ServerStore(file);
    reloaded.load();

    expect(reloaded.list()).toEqual([{ ...server, name: "Garage" }]);
    expect(reloaded.findByUrl(server.url)?.id).toBe("a");
  });

  it("keeps the file private to the user", () => {
    const store = new ServerStore(file);
    store.add(server);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("removes servers", () => {
    const store = new ServerStore(file);
    store.add(server);
    store.remove("a");

    expect(store.list()).toEqual([]);
    expect(store.get("a")).toBeUndefined();
  });

  it("skips invalid entries", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        servers: [server, { id: "b" }, { ...server, id: "c", url: "ftp://x/" }],
      }),
    );
    const store = new ServerStore(file);
    store.load();

    expect(store.list().map((entry) => entry.id)).toEqual(["a"]);
  });

  it("sets an unreadable file aside instead of overwriting it", () => {
    fs.writeFileSync(file, "{not json");
    const store = new ServerStore(file);
    store.load();

    expect(store.list()).toEqual([]);
    expect(fs.readFileSync(`${file}.invalid`, "utf8")).toBe("{not json");
  });

  it("hands out copies", () => {
    const store = new ServerStore(file);
    store.add(server);
    store.list()[0].name = "changed";

    expect(store.get("a")?.name).toBe("Home");
  });
});
