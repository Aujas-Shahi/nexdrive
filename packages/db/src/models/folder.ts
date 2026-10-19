import { Schema } from "mongoose";
import type { Types } from "mongoose";
import { getModel } from "./plugins";

/**
 * FOLDER — the adjacency-list tree.
 *
 * A folder has at most one parent (`parentId`, null at the root) and any number
 * of children. Rename and move are one-field updates, and the tree stays shallow
 * enough that trash/restore can walk it in application code.
 */
export interface FolderDoc {
  _id: Types.ObjectId;
  name: string;
  userId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  deletedAt: Date | null; // soft delete → trash
  createdAt: Date;
  updatedAt: Date;
}

const folderSchema = new Schema<FolderDoc>(
  {
    name: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Folder", default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "folders" },
);

// Listing the subfolders of one folder, newest first, trashed hidden.
folderSchema.index({ userId: 1, parentId: 1, deletedAt: 1 });
// Trash listing.
folderSchema.index({ userId: 1, deletedAt: 1 });
// Recursive tree walks key off parent.
folderSchema.index({ parentId: 1 });

export const Folder = getModel<FolderDoc>("Folder", folderSchema);
