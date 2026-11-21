import { describe, expect, it } from "vitest";

import {
  interpretProfile,
  isFrigateLoginInfo,
  redirectSuggestion,
} from "../src/main/probe";

describe("isFrigateLoginInfo", () => {
  it("recognizes Frigate's public login info", () => {
    expect(isFrigateLoginInfo(200, { admin_first_time_login: false })).toBe(
      true,
    );
  });

  it("rejects other answers", () => {
    expect(isFrigateLoginInfo(200, { status: "ok" })).toBe(false);
    expect(isFrigateLoginInfo(404, { admin_first_time_login: false })).toBe(
      false,
    );
    expect(isFrigateLoginInfo(200, null)).toBe(false);
  });
});

describe("interpretProfile", () => {
  it("treats a 401 as a server that requires sign-in", () => {
    expect(interpretProfile(401, null)).toEqual({
      kind: "ok",
      loginRequired: true,
    });
  });

  it("refuses the internal port's anonymous admin", () => {
    expect(
      interpretProfile(200, {
        username: "anonymous",
        role: "admin",
        allowed_cameras: [],
      }),
    ).toEqual({ kind: "rejected", reason: "internal_port" });
  });

  it("accepts a server with auth off, noting no sign-in is needed", () => {
    expect(
      interpretProfile(200, { username: "viewer", role: "admin" }),
    ).toEqual({
      kind: "ok",
      loginRequired: false,
    });
  });

  it("rejects anything else", () => {
    expect(interpretProfile(500, null)).toEqual({
      kind: "rejected",
      reason: "not_frigate",
    });
    expect(interpretProfile(200, "<html>")).toEqual({
      kind: "rejected",
      reason: "not_frigate",
    });
  });
});

describe("redirectSuggestion", () => {
  const base = "http://frigate.lan:8971/";
  const request = `${base}api/auth/first_time_login`;
  const path = "api/auth/first_time_login";

  it("suggests the base address the same path moved to", () => {
    expect(
      redirectSuggestion(
        request,
        "https://frigate.lan:8971/api/auth/first_time_login",
        path,
        base,
      ),
    ).toBe("https://frigate.lan:8971/");
    expect(
      redirectSuggestion(
        request,
        "https://proxy.example/frigate/api/auth/first_time_login?x=1",
        path,
        base,
      ),
    ).toBe("https://proxy.example/frigate/");
  });

  it("suggests nothing for a redirect to another page", () => {
    expect(
      redirectSuggestion(request, "https://sso.example/login", path, base),
    ).toBeNull();
    expect(redirectSuggestion(request, "/login", path, base)).toBeNull();
  });

  it("suggests nothing for a redirect back to the same address", () => {
    expect(
      redirectSuggestion(
        request,
        "/api/auth/first_time_login?again",
        path,
        base,
      ),
    ).toBeNull();
  });
});
