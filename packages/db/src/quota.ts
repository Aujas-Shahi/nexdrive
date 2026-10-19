import type { ClientSession, Types } from "mongoose";
import { DEFAULT_RATE_LIMIT, DEFAULT_STORAGE_LIMIT } from "./constants";
import { User, type Quota } from "./models/user";

function defaultQuota(): Quota {
  return {
    storageUsed: 0,
    storageLimit: DEFAULT_STORAGE_LIMIT,
    rateLimit: DEFAULT_RATE_LIMIT,
    updatedAt: new Date(),
  };
}

/**
 * Lazily initialize the embedded quota for a user.
 *
 * The auth layer creates users without a quota, so the first request from a new
 * account fills it in here — matching the "initialized lazily on first access"
 * rule in the design document.
 */
export async function ensureQuota(
  userId: string | Types.ObjectId,
): Promise<Quota> {
  await User.updateOne(
    {
      _id: userId,
      $or: [{ quota: { $exists: false } }, { quota: null }],
    },
    { $set: { quota: defaultQuota() } },
  );

  const user = await User.findById(userId).select("quota").lean();
  return user?.quota ?? defaultQuota();
}

/** Read a user's quota, falling back to defaults if it was never touched. */
export async function getQuota(
  userId: string | Types.ObjectId,
): Promise<Quota> {
  const user = await User.findById(userId).select("quota").lean();
  return user?.quota ?? defaultQuota();
}

/**
 * Adjust a user's logical storage usage by `delta` bytes, clamping at zero.
 *
 * An aggregation-pipeline update lets the clamp happen on the server, so a
 * delete that races an upload can never drive `storageUsed` negative. Pass a
 * `session` to make the change part of a multi-document transaction.
 */
export async function adjustStorageUsed(
  userId: string | Types.ObjectId,
  delta: number,
  session?: ClientSession,
): Promise<void> {
  await User.updateOne(
    { _id: userId },
    [
      {
        $set: {
          "quota.storageUsed": {
            $max: [
              0,
              {
                $add: [{ $ifNull: ["$quota.storageUsed", 0] }, delta],
              },
            ],
          },
          "quota.storageLimit": {
            $ifNull: ["$quota.storageLimit", DEFAULT_STORAGE_LIMIT],
          },
          "quota.rateLimit": {
            $ifNull: ["$quota.rateLimit", DEFAULT_RATE_LIMIT],
          },
          "quota.updatedAt": new Date(),
        },
      },
    ],
    // Mongoose 9 requires opting in before an aggregation-pipeline update.
    { session, updatePipeline: true },
  );
}
