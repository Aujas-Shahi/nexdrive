import { Schema } from "mongoose";
import { getModel } from "./plugins";

/**
 * FILE — the content-addressable blob registry.
 *
 * The SHA-256 hash *is* the primary key, so the dedup check every upload starts
 * with is a single point-read: `File.findById(hash)`. No secondary key, no extra
 * index, no join.
 */
export interface FileDoc {
  _id: string; // SHA-256 hash of the content
  size: number; // bytes
  path: string; // object key in R2
  refCount: number; // number of assets claiming it
  createdAt: Date;
  updatedAt: Date;
}

const fileSchema = new Schema<FileDoc>(
  {
    _id: { type: String },
    size: { type: Number, required: true },
    path: { type: String, required: true },
    refCount: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "files",
  },
);

// Blob registry is swept by refCount when deciding when to reclaim storage.
fileSchema.index({ refCount: 1 });

export const File = getModel<FileDoc>("File", fileSchema);
