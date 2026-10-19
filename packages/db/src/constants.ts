/**
 * Shared defaults and collection names for NexDrive.
 *
 * These mirror the values committed to in the Review 1 design document so the
 * database layer, the API layer, and the sample dataset all agree.
 */

/** Logical bytes a new user may store before uploads are rejected. */
export const DEFAULT_STORAGE_LIMIT = 1 * 1024 ** 3; // 1 GB

/** API requests allowed per one-second window, per user. */
export const DEFAULT_RATE_LIMIT = 2;

/** Duration of a rate-limit window. */
export const RATE_LIMIT_WINDOW_MS = 1000;

/** Largest single upload accepted (the client hashes before uploading). */
export const MAX_FILE_SIZE = 10 * 1024 ** 3; // 10 GB

/**
 * How long a rate-limit window document survives before the TTL index removes
 * it. Comfortably longer than the window itself so in-flight counters are never
 * read after expiry.
 */
export const RATE_LIMIT_WINDOW_TTL_SECONDS = 60;

/**
 * Physical collection names. The auth collections keep singular names because
 * Better Auth's MongoDB adapter maps models to `user`, `session`, `account`,
 * and `verification` unless told otherwise.
 */
export const COLLECTIONS = {
  user: "user",
  session: "session",
  account: "account",
  verification: "verification",
  files: "files",
  folders: "folders",
  assets: "assets",
  rateLimitWindows: "rate_limit_windows",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
