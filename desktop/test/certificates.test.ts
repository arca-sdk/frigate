import { describe, expect, it } from "vitest";

import {
  ACCEPT_CERTIFICATE,
  isCertificateError,
  USE_CHROMIUM_RESULT,
  verifyCertificate,
} from "../src/main/certificates";

const certificate = {
  fingerprint: "sha256/pinned",
  subjectName: "*",
  issuerName: "*",
  validStart: 0,
  validExpiry: 1,
};
const untrusted = { hostname: "frigate.local", errorCode: -202, certificate };

describe("verifyCertificate", () => {
  it("accepts the pinned certificate for the server's host", () => {
    expect(verifyCertificate(untrusted, "frigate.local", "sha256/pinned")).toBe(
      ACCEPT_CERTIFICATE,
    );
  });

  it("leaves certificates the system trusts to Chromium", () => {
    expect(
      verifyCertificate(
        { ...untrusted, errorCode: 0 },
        "frigate.local",
        "sha256/pinned",
      ),
    ).toBe(USE_CHROMIUM_RESULT);
  });

  it("rejects a different certificate", () => {
    expect(
      verifyCertificate(
        {
          ...untrusted,
          certificate: { ...certificate, fingerprint: "sha256/other" },
        },
        "frigate.local",
        "sha256/pinned",
      ),
    ).toBe(USE_CHROMIUM_RESULT);
  });

  it("doesn't accept the pinned certificate for another host", () => {
    expect(
      verifyCertificate(
        { ...untrusted, hostname: "evil.example" },
        "frigate.local",
        "sha256/pinned",
      ),
    ).toBe(USE_CHROMIUM_RESULT);
  });

  it("rejects everything the system doesn't trust when nothing is pinned", () => {
    expect(verifyCertificate(untrusted, "frigate.local", null)).toBe(
      USE_CHROMIUM_RESULT,
    );
  });

  it("matches IPv6 hosts with or without brackets", () => {
    expect(
      verifyCertificate(
        { ...untrusted, hostname: "[fd00::5]" },
        "fd00::5",
        "sha256/pinned",
      ),
    ).toBe(ACCEPT_CERTIFICATE);
  });
});

describe("isCertificateError", () => {
  it("covers Chromium's certificate error range only", () => {
    expect(isCertificateError(-202)).toBe(true);
    expect(isCertificateError(-200)).toBe(true);
    expect(isCertificateError(-102)).toBe(false);
    expect(isCertificateError(-300)).toBe(false);
  });
});
