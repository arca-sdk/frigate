import { describe, expect, it } from "vitest";

import {
  isExternalLink,
  isSameOrigin,
  parseServerUrl,
} from "../src/main/serverUrl";

describe("parseServerUrl", () => {
  it("gives a bare host https and Frigate's sign-in port", () => {
    expect(parseServerUrl("frigate.local")).toEqual({
      ok: true,
      url: "https://frigate.local:8971/",
      origin: "https://frigate.local:8971",
      hostname: "frigate.local",
    });
  });

  it("keeps the port of a bare host:port", () => {
    expect(parseServerUrl(" 192.168.1.20:8443 ")).toMatchObject({
      ok: true,
      url: "https://192.168.1.20:8443/",
    });
  });

  it("keeps an address with a scheme as typed", () => {
    expect(parseServerUrl("https://k3m9.example-tunnels.net")).toMatchObject({
      ok: true,
      url: "https://k3m9.example-tunnels.net/",
    });
    expect(parseServerUrl("http://frigate.lan:8971")).toMatchObject({
      ok: true,
      url: "http://frigate.lan:8971/",
    });
  });

  it("keeps a base path and drops the query and fragment", () => {
    expect(
      parseServerUrl("https://proxy.example/frigate?x=1#live"),
    ).toMatchObject({
      ok: true,
      url: "https://proxy.example/frigate/",
      origin: "https://proxy.example",
    });
  });

  it("refuses the internal port", () => {
    expect(parseServerUrl("frigate.local:5000")).toEqual({
      ok: false,
      reason: "internal_port",
    });
    expect(parseServerUrl("http://frigate.local:5000/")).toEqual({
      ok: false,
      reason: "internal_port",
    });
  });

  it("refuses other schemes, credentials and garbage", () => {
    expect(parseServerUrl("ftp://frigate.local")).toEqual({
      ok: false,
      reason: "unsupported_scheme",
    });
    expect(parseServerUrl("https://admin:secret@frigate.local")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(parseServerUrl("")).toEqual({ ok: false, reason: "invalid_url" });
    expect(parseServerUrl("https://")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("strips the brackets from IPv6 hostnames", () => {
    expect(parseServerUrl("[fd00::5]")).toMatchObject({
      ok: true,
      url: "https://[fd00::5]:8971/",
      hostname: "fd00::5",
    });
  });
});

describe("isSameOrigin", () => {
  it("compares scheme, host and port", () => {
    const server = "https://frigate.local:8971/";

    expect(isSameOrigin("https://frigate.local:8971/review?id=1", server)).toBe(
      true,
    );
    expect(isSameOrigin("http://frigate.local:8971/", server)).toBe(false);
    expect(isSameOrigin("https://frigate.local:5000/", server)).toBe(false);
    expect(isSameOrigin("https://evil.example/", server)).toBe(false);
    expect(isSameOrigin("not a url", server)).toBe(false);
  });
});

describe("isExternalLink", () => {
  it("only hands web and mail links to the system", () => {
    expect(isExternalLink("https://docs.frigate.video")).toBe(true);
    expect(isExternalLink("mailto:someone@example.com")).toBe(true);
    expect(isExternalLink("file:///etc/passwd")).toBe(false);
    expect(isExternalLink("smb://share/x")).toBe(false);
    expect(isExternalLink("javascript:alert(1)")).toBe(false);
  });
});
