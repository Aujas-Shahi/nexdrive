import { Schema } from "mongoose";
import type { Types } from "mongoose";
import { RATE_LIMIT_WINDOW_TTL_SECONDS } from "../constants";
import { getModel } from "./plugins";

/**
 * RATE_LIMIT_WINDOW — ephemeral, self-expiring.
 *
 * One document per user per one-second window. The TTL index deletes stale
 * windows automatically, so there is no cleanup job anywhere in the codebase,
 * and losing this collection is harmless by design.
 */
export interface RateLimitWindowDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  windowStart: Date;
  requestCount: number;
  createdAt: Date;
}

const rateLimitWindowSchema = new Schema<RateLimitWindowDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    windowStart: { type: Date, required: true },
    requestCount: { type: Number, default: 1 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "rate_limit_windows",
  },
);

// The counter for a given user in a given window.
rateLimitWindowSchema.index({ userId: 1, windowStart: 1 }, { unique: true });
// TTL: drop each window shortly after it stops mattering.
rateLimitWindowSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: RATE_LIMIT_WINDOW_TTL_SECONDS },
);

export const RateLimitWindow = getModel<RateLimitWindowDoc>(
  "RateLimitWindow",
  rateLimitWindowSchema,
);
