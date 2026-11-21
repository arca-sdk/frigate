/** Trust on first use for certificates the system doesn't trust. */

import type { CertificateInfo } from "../shared/types";
import { bareHostname } from "./serverUrl";

/** Results a certificate verify proc can return (see Session.setCertificateVerifyProc). */
export const ACCEPT_CERTIFICATE = 0;
export const USE_CHROMIUM_RESULT = -3;

/** The fields of Electron's Certificate this module reads. */
type CertificateLike = Pick<
  Electron.Certificate,
  "fingerprint" | "subjectName" | "issuerName" | "validStart" | "validExpiry"
>;

/**
 * Decide whether to accept a certificate for a server's session.
 *
 * A certificate the system already trusts is always accepted. Otherwise only
 * the exact certificate the user pinned for this server's host is, so a
 * pinned self-signed certificate can't be reused for any other host.
 */
export function verifyCertificate(
  request: {
    hostname: string;
    errorCode: number;
    certificate: CertificateLike;
  },
  serverHostname: string,
  pinnedFingerprint: string | null,
): number {
  if (
    request.errorCode !== 0 &&
    pinnedFingerprint !== null &&
    bareHostname(request.hostname) === serverHostname &&
    request.certificate.fingerprint === pinnedFingerprint
  ) {
    return ACCEPT_CERTIFICATE;
  }

  return USE_CHROMIUM_RESULT;
}

export function toCertificateInfo(
  certificate: CertificateLike,
): CertificateInfo {
  return {
    fingerprint: certificate.fingerprint,
    subjectName: certificate.subjectName,
    issuerName: certificate.issuerName,
    validStart: certificate.validStart,
    validExpiry: certificate.validExpiry,
  };
}

/** Chromium's certificate errors are net error codes -200 to -299. */
export function isCertificateError(errorCode: number): boolean {
  return errorCode <= -200 && errorCode > -300;
}
