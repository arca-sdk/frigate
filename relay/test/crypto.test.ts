import { describe, expect, it } from "vitest";

import { clerkFrontendApi } from "../src/config.ts";
import { newInstanceId, newUserCode, normalizeUserCode, timingSafeEqualStrings } from "../src/crypto.ts";

describe("codes and ids", () => {
  it("makes user codes that survive normalization", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newUserCode();
      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u);
      expect(normalizeUserCode(code.toLowerCase().replace("-", " "))).toBe(code);
    }
  });

  it("rejects text that cannot be a code", () => {
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });

  it("makes DNS-safe instance ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newInstanceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z2-9]{16}$/u);
    }
  });

  it("compares secrets", () => {
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(timingSafeEqualStrings("abc", "abcd")).toBe(false);
  });
});

describe("Clerk publishable keys", () => {
  it("decode to the Frontend API host", () => {
    expect(clerkFrontendApi(`pk_live_${btoa("clerk.example.com$")}`)).toBe("clerk.example.com");
    expect(clerkFrontendApi("sk_live_abc")).toBeNull();
    expect(clerkFrontendApi("pk_test_%%%")).toBeNull();
  });
});
