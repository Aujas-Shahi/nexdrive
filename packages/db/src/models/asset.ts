import { Schema } from "mongoose";
import type { Types } from "mongoose";
import { getModel } from "./plugins";

/**
 * ASSET — one document per user-file claim.
 *
 * Where `files` owns the shared blob, `assets` owns everything per-user: the
 * visible name, the folder it sits in, sharing state, download count, and its
 * own trash timestamp. That split is what keeps every per-user view (folder
 * listing, trash listing, shares) a single-collection `find` with no joins.
 */
export interface AssetDoc {
  _id: Types.ObjectId;
  name: string;
  contentType: string | null;
  userId: Types.ObjectId;
  folderId: Types.ObjectId | null;
  fileHash: string; // -> files._id
  isPublic: boolean;
  publicShareId: string | null;
  downloadCount: number;
  deletedAt: Date | null; // soft delete → trash
  createdAt: Date;
  updatedAt: Date;
}

const assetSchema = new Schema<AssetDoc>(
  {
    name: { type: String, required: true },
    contentType: { type: String, default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    folderId: { type: Schema.Types.ObjectId, ref: "Folder", default: null },
    fileHash: { type: String, required: true },
    isPublic: { type: Boolean, default: false },
    publicShareId: { type: String, default: null },
    downloadCount: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "assets" },
);

// Folder listing.
assetSchema.index({ userId: 1, folderId: 1, deletedAt: 1 });
// Trash listing, newest-deleted first.
assetSchema.index({ userId: 1, deletedAt: 1, createdAt: -1 });
// Per-user dedup statistics.
assetSchema.index({ userId: 1, fileHash: 1 });
// Public share lookup. Partial so the many `null` share ids don't collide.
assetSchema.index(
  { publicShareId: 1 },
  {
    unique: true,
    partialFilterExpression: { publicShareId: { $type: "string" } },
  },
);

export const Asset = getModel<AssetDoc>("Asset", assetSchema);
