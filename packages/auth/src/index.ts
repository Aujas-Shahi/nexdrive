import { getClient, getDb } from "@nexdrive/db";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";

const corsOrigin = process.env.CORS_ORIGIN;
if (!corsOrigin) {
  throw new Error("CORS_ORIGIN environment variable is required");
}

/**
 * Build the Better Auth instance against the shared MongoDB connection.
 *
 * Constructed lazily and memoized: the adapter needs a live `Db`, and the
 * connection is established in the server bootstrap. Creating it at module load
 * would run before `connectDB()` has a chance to finish.
 */
function createAuth() {
  return betterAuth({
    database: mongodbAdapter(getDb(), {
      // Passing the client enables the adapter's multi-document transactions,
      // which requires a replica set — the same requirement as our own flows.
      client: getClient(),
    }),
    trustedOrigins: [corsOrigin!],
    emailAndPassword: {
      enabled: true,
    },
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
  });
}

let _auth: ReturnType<typeof createAuth> | null = null;

/** The process-wide Better Auth instance. Call after `connectDB()`. */
export function getAuth(): ReturnType<typeof createAuth> {
  if (!_auth) {
    _auth = createAuth();
  }
  return _auth;
}

export type Auth = ReturnType<typeof getAuth>;
