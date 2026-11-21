/** Random identifiers, secrets and hashing for the relay. */

// Consonants only, so a code never spells a word, and nothing that reads as
// another character.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
// DNS-safe and free of characters that are easy to misread (l, o, 0, 1).
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

const USER_CODE_LENGTH = 8;

function randomString(alphabet: string, length: number): string {
  // Reject bytes past the last whole multiple of the alphabet size so every
  // character is equally likely.
  const limit = 256 - (256 % alphabet.length);
  let result = "";
  while (result.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit) {
        result += alphabet[byte % alphabet.length];
        if (result.length === length) {
          break;
        }
      }
    }
  }
  return result;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** A code such as `BCDF-GHJK` that the account owner confirms. */
export function newUserCode(): string {
  const code = randomString(USER_CODE_ALPHABET, USER_CODE_LENGTH);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Accept a user code typed with any case, spacing or dashes. Returns the
 * canonical `XXXX-XXXX` form, or null when it cannot be a code.
 */
export function normalizeUserCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[^A-Z]/gu, "");
  if (compact.length !== USER_CODE_LENGTH) {
    return null;
  }
  for (const character of compact) {
    if (!USER_CODE_ALPHABET.includes(character)) {
      return null;
    }
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** 80 random bits, used as the first label of the instance's hostname. */
export function newInstanceId(): string {
  return randomString(ID_ALPHABET, 16);
}

export function newRequestId(): string {
  return randomString(ID_ALPHABET, 20);
}

/** 256 random bits for device codes and instance secrets. */
export function newSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Secrets are random and long, so a plain digest is enough to keep a database
 * leak from revealing them; there is nothing to brute-force.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(left, right);
}
