/**
 * Who is calling: a person signed in with Clerk, or a linked Frigate holding
 * its instance secret. The two never share credentials.
 */

import { createClerkClient, verifyToken } from "@clerk/backend";

import { sha256Hex, timingSafeEqualStrings } from "./crypto.ts";
import { HttpError, bearerToken } from "./http.ts";
import type { InstanceRow, Store } from "./store.ts";

export interface UserIdentity {
  readonly userId: string;
}

export interface UserAuthenticator {
  /** Throws a 401 HttpError when the request has no valid session. */
  authenticate(request: Request): Promise<UserIdentity>;
}

export interface AccountDirectory {
  /** A label such as the account's email, shown to the Frigate's admins. */
  labelFor(userId: string): Promise<string | null>;
}

export function createClerkAuthenticator(options: {
  readonly secretKey: string;
  readonly publicUrl: string | null;
}): UserAuthenticator {
  return {
    async authenticate(request) {
      const token = bearerToken(request);
      if (token === null) {
        throw new HttpError(401, "unauthenticated", "Sign in first");
      }
      // Session tokens name the page origin that requested them. Only the
      // relay's own pages may call these routes.
      const origin = options.publicUrl ?? new URL(request.url).origin;
      try {
        const payload = await verifyToken(token, {
          secretKey: options.secretKey,
          authorizedParties: [origin],
        });
        if (typeof payload.sub !== "string" || payload.sub.length === 0) {
          throw new Error("token has no subject");
        }
        return { userId: payload.sub };
      } catch {
        throw new HttpError(401, "unauthenticated", "Your session is not valid; sign in again");
      }
    },
  };
}

export function createClerkDirectory(secretKey: string): AccountDirectory {
  const clerk = createClerkClient({ secretKey });
  return {
    async labelFor(userId) {
      const user = await clerk.users.getUser(userId);
      return user.primaryEmailAddress?.emailAddress ?? user.username ?? null;
    },
  };
}

/** Bearer `<instance id>.<secret>`, as issued when the link completed. */
export async function authenticateInstance(request: Request, store: Store): Promise<InstanceRow> {
  const token = bearerToken(request);
  const separator = token?.indexOf(".") ?? -1;
  if (token === null || separator <= 0) {
    throw new HttpError(401, "invalid_instance_credentials", "Missing instance credentials");
  }
  const instance = await store.getInstance(token.slice(0, separator));
  const presented = await sha256Hex(token.slice(separator + 1));
  // Compare even when there is nothing to compare against, so a missing
  // instance takes as long as a wrong secret.
  const matches = timingSafeEqualStrings(presented, instance?.secret_hash ?? "0".repeat(presented.length));
  if (instance === null || instance.state !== "active" || instance.secret_hash === null || !matches) {
    throw new HttpError(401, "invalid_instance_credentials", "This Frigate is no longer linked");
  }
  return instance;
}
