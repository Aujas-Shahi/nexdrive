/**
 * @nexdrive/db — the NexDrive MongoDB data layer.
 *
 * Exposes the shared connection, the Mongoose models for the five domain
 * collections (plus the `user` view that carries the embedded quota), the quota
 * helpers, the index builder, and the transaction wrapper.
 */
export {
  connectDB,
  getClient,
  getDb,
  mongoose,
  withTransaction,
} from "./connection";

export * from "./constants";
export * from "./objectid";

export * from "./models";
export {
  adjustStorageUsed,
  ensureQuota,
  getQuota,
} from "./quota";

export { ensureIndexes } from "./indexes";
export { ensureValidators, VALIDATORS } from "./validators";
