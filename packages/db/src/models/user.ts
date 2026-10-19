import { Schema } from "mongoose";
import type { Types } from "mongoose";
import { DEFAULT_RATE_LIMIT, DEFAULT_STORAGE_LIMIT } from "../constants";
import { getModel } from "./plugins";

/**
 * QUOTA — embedded in the user document.
 *
 * The quota is 1:1 with a user, tiny, and read on nearly every request, so it
 * embeds rather than becoming its own collection. `$inc` updates it atomically
 * alongside the owning user, which is what keeps the upload/delete flows honest.
 */
export interface Quota {
  storageUsed: number; // logical bytes
  storageLimit: number; // bytes
  rateLimit: number; // req/sec
  updatedAt: Date;
}

const quotaSchema = new Schema<Quota>(
  {
    storageUsed: { type: Number, default: 0 },
    storageLimit: { type: Number, default: DEFAULT_STORAGE_LIMIT },
    rateLimit: { type: Number, default: DEFAULT_RATE_LIMIT },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * USER — owned and written by Better Auth's MongoDB adapter.
 *
 * We only ever touch `quota` here; every other field is Better Auth's business.
 * `strict: false` guarantees we never strip fields the adapter wrote. Quota is
 * initialized lazily on first access rather than at user creation, matching the
 * upload flow in the design document.
 */
export interface UserDoc {
  _id: Types.ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  quota?: Quota;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    emailVerified: { type: Boolean, default: false },
    image: { type: String, default: null },
    quota: { type: quotaSchema, default: () => ({}) },
  },
  {
    timestamps: true,
    strict: false,
    collection: "user",
  },
);

export const User = getModel<UserDoc>("User", userSchema);
