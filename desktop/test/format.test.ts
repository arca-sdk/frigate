import { describe, expect, it } from "vitest";

import { formatFingerprint } from "../src/shared/format";

describe("formatFingerprint", () => {
  it("prints a sha256 fingerprint the way openssl does", () => {
    const bytes = Buffer.from("00ff10ab", "hex").toString("base64");

    expect(formatFingerprint(`sha256/${bytes}`)).toBe("00:FF:10:AB");
  });

  it("keeps the slashes base64 can contain", () => {
    const bytes = Buffer.from("fbffff", "hex").toString("base64");

    expect(bytes).toBe("+///");
    expect(formatFingerprint(`sha256/${bytes}`)).toBe("FB:FF:FF");
  });

  it("leaves unknown formats alone", () => {
    expect(formatFingerprint("sha1/abc")).toBe("sha1/abc");
    expect(formatFingerprint("sha256/!!!")).toBe("sha256/!!!");
  });
});
