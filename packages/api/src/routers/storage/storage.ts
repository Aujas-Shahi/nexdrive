import { z } from "zod";
import { S3Client } from "bun";
import { TRPCError } from "@trpc/server";
import {
  Asset,
  DEFAULT_RATE_LIMIT,
  File,
  Folder,
  MAX_FILE_SIZE,
  RATE_LIMIT_WINDOW_MS,
  RateLimitWindow,
  adjustStorageUsed,
  ensureQuota,
  getQuota as readQuota,
  idString,
  toObjectId,
  withTransaction,
} from "@nexdrive/db";
import { router, protectedProcedure, publicProcedure } from "../../index";
import { getEnv } from "../../env";

// A converted ObjectId, as returned by `toObjectId`.
type Oid = ReturnType<typeof toObjectId>;
// The transaction session passed to `withTransaction` callbacks.
type Session = Parameters<Parameters<typeof withTransaction>[0]>[0];

// Get validated environment
const env = getEnv();

// S3 Client configuration
const s3 = new S3Client({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET_NAME,
  endpoint: env.R2_ENDPOINT,
  region: "auto", // R2 uses "auto" for region
});

/**
 * ObjectId input. Ids cross the wire as 24-character hex strings; MongoDB will
 * not match a string against an ObjectId, so every id is converted before use.
 */const objectIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

// Validation schemas
/**
 * Filename validation:
 * - 1-255 characters
 * - Cannot contain path traversal characters (/, \, ..)
 * - Cannot contain null bytes
 * - Cannot be reserved names on Windows (CON, PRN, AUX, etc.)
 */
const filenameSchema = z
  .string()
  .min(1, "Filename is required")
  .max(255, "Filename must be 255 characters or less")
  .regex(/^[^\/\\:\*\?"<>\|\x00]+$/, "Filename contains invalid characters")
  .refine(
    (name) => !name.includes(".."),
    "Filename cannot contain path traversal sequences",
  )
  .refine(
    (name) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name),
    "Filename is a reserved system name",
  );

/**
 * Content type validation:
 * - Must be a valid MIME type format (type/subtype)
 * - Optionally with parameters (e.g., charset=utf-8)
 */
const contentTypeSchema = z
  .string()
  .regex(
    /^[a-z]+\/[a-z0-9.+-]+(\s*;\s*[a-z0-9-]+=\S+)*$/i,
    "Invalid MIME type format",
  )
  .optional();

/**
 * File size validation:
 * - Must be positive
 * - Maximum 10GB
 */
const fileSizeSchema = z
  .number()
  .positive("File size must be positive")
  .max(
    MAX_FILE_SIZE,
    `File size cannot exceed ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB`,
  );

// Helper: Get user ID from session
const getUserId = (ctx: { session: { user: { id: string } } }) =>
  ctx.session.user.id;

// Helper: Serialize a lean folder document to the API shape the client expects
function serializeFolder(folder: {
  _id: unknown;
  name: string;
  userId: unknown;
  parentId?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
}) {
  return {
    id: String(folder._id),
    name: folder.name,
    userId: idString(folder.userId),
    parentId: idString(folder.parentId),
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    deletedAt: folder.deletedAt ?? null,
  };
}

// Helper: Serialize a lean asset document to the API shape the client expects
function serializeAsset(asset: {
  _id: unknown;
  name: string;
  contentType?: string | null;
  userId: unknown;
  folderId?: unknown;
  fileHash: string;
  isPublic?: boolean;
  publicShareId?: string | null;
  downloadCount?: number;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: String(asset._id),
    name: asset.name,
    contentType: asset.contentType ?? null,
    userId: idString(asset.userId),
    folderId: idString(asset.folderId),
    fileHash: asset.fileHash,
    isPublic: asset.isPublic ?? false,
    publicShareId: asset.publicShareId ?? null,
    downloadCount: asset.downloadCount ?? 0,
    deletedAt: asset.deletedAt ?? null,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

// Helper: Check and enforce rate limit
//
// Only mutations are rate-limited; reads are free so a dashboard that fires
// several queries on load can never trip its own limiter. One document per user
// per one-second window is incremented atomically, so concurrent requests cannot
// lose counts. A request that pushes the count past the cap is rejected — it
// still consumes a slot, which is race-safe and prevents bursts. Stale windows
// are removed by the collection's TTL index, not by this code.
async function checkRateLimit(userId: string): Promise<void> {
  const now = new Date();
  const windowStart = new Date(
    Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS,
  );
  const userObjectId = toObjectId(userId);

  const quota = await readQuota(userObjectId);
  const rateLimit = quota.rateLimit ?? DEFAULT_RATE_LIMIT;

  const window = await RateLimitWindow.findOneAndUpdate(
    { userId: userObjectId, windowStart },
    { $inc: { requestCount: 1 } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ).lean();

  if ((window?.requestCount ?? 1) > rateLimit) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit exceeded. Maximum ${rateLimit} requests per second.`,
    });
  }
}

// Helper: Check storage quota
async function checkStorageQuota(
  userId: string,
  additionalBytes: number,
): Promise<void> {
  const quota = await ensureQuota(toObjectId(userId));

  if (quota.storageUsed + additionalBytes > quota.storageLimit) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Storage quota exceeded. Used: ${formatBytes(quota.storageUsed)}, Limit: ${formatBytes(quota.storageLimit)}, Requested: ${formatBytes(additionalBytes)}`,
    });
  }
}

// Helper: Format bytes for display
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Delete one asset claim and release its blob reference.
 *
 * Every deletion path funnels through here: permanent-delete, folder hard-delete,
 * and empty-trash all drop the claim, decrement the blob's refCount, and — when
 * the last reference goes — record the blob key for removal from object storage
 * and drop the registry entry. Returns the freed logical bytes and, if the blob
 * is now unreferenced, the R2 key to delete *after* the transaction commits
 * (object storage is not transactional).
 */
async function releaseAsset(
  session: Session,
  asset: { _id: Oid; fileHash: string },
  blobSize: number,
): Promise<{ freedBytes: number; blobToDelete: string | null }> {
  await Asset.deleteOne({ _id: asset._id }, { session });

  const updatedFile = await File.findOneAndUpdate(
    { _id: asset.fileHash },
    { $inc: { refCount: -1 } },
    { returnDocument: "after", session },
  ).lean();

  let blobToDelete: string | null = null;
  if (updatedFile && updatedFile.refCount <= 0) {
    blobToDelete = updatedFile.path;
    await File.deleteOne({ _id: asset.fileHash }, { session });
  }

  return { freedBytes: blobSize, blobToDelete };
}

/**
 * Collect a folder and its descendants.
 *
 * `filter` decides which folders are included: `{ deletedAt: null }` for live
 * folders being trashed, `{ deletedAt: { $ne: null } }` for restoring, and `{}`
 * for permanent deletion. The tree is walked in application code, as the design
 * document specifies, because folder trees are shallow and bounded.
 */
async function collectSubtree(
  userId: Oid,
  rootId: Oid,
  filter: Record<string, unknown>,
): Promise<Oid[]> {
  const children = await Folder.find({ userId, parentId: rootId, ...filter })
    .select("_id")
    .lean();

  const ids: Oid[] = [rootId];
  for (const child of children) {
    ids.push(...(await collectSubtree(userId, child._id, filter)));
  }
  return ids;
}

/** True when `checkId` sits below `ancestorId` in the folder tree. */
async function isDescendant(
  ancestorId: string,
  checkId: string | Oid,
): Promise<boolean> {
  const check = await Folder.findById(checkId).select("parentId").lean();
  if (!check || !check.parentId) return false;
  if (String(check.parentId) === ancestorId) return true;
  return isDescendant(ancestorId, check.parentId);
}

// Rate limited procedure - wraps protectedProcedure with rate limit check
const rateLimitedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await checkRateLimit(getUserId(ctx));
  return next();
});

export const storageRouter = router({
  // ============================================
  // UPLOAD AND DEDUPLICATION
  // ============================================

  /**
   * Get presigned URL for upload with deduplication check
   * If file already exists (same hash), returns deduplicated status
   */
  getUploadPresignedUrl: rateLimitedProcedure
    .input(
      z.object({
        filename: filenameSchema,
        size: fileSizeSchema,
        hash: z.string().regex(/^[a-f0-9]{64}$/i, "Invalid SHA-256 hash"),
        contentType: contentTypeSchema,
        folderId: objectIdSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Check storage quota before proceeding
      await checkStorageQuota(userId, input.size);

      // Check for deduplication: one point-read on the content hash.
      const existingFile = await File.findById(input.hash).lean();

      if (existingFile) {
        // File content already exists - create a reference without uploading.
        // The asset insert, ref-count bump, and quota delta commit together.
        await withTransaction(async (session) => {
          await Asset.create(
            [
              {
                name: input.filename,
                contentType: input.contentType ?? null,
                userId: userObjectId,
                folderId: input.folderId ? toObjectId(input.folderId) : null,
                fileHash: existingFile._id,
              },
            ],
            { session },
          );

          await File.updateOne(
            { _id: existingFile._id },
            { $inc: { refCount: 1 } },
            { session },
          );

          await adjustStorageUsed(userId, input.size, session);
        });

        return {
          deduplicated: true,
          url: null,
          key: null,
          message:
            "File already exists, created reference without re-uploading",
        };
      }

      // File doesn't exist - generate presigned URL for upload
      const key = input.hash; // Store by hash for deduplication
      const url = s3.presign(key, {
        method: "PUT",
        expiresIn: 3600, // 1 hour
      });

      return {
        deduplicated: false,
        url,
        key,
        message: "Upload to presigned URL, then call confirmUpload",
      };
    }),

  /**
   * Confirm upload after file has been uploaded to S3
   */
  confirmUpload: rateLimitedProcedure
    .input(
      z.object({
        filename: filenameSchema,
        size: fileSizeSchema,
        hash: z.string().regex(/^[a-f0-9]{64}$/i, "Invalid SHA-256 hash"),
        contentType: contentTypeSchema,
        folderId: objectIdSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Verify file exists in S3
      const exists = await s3.file(input.hash).exists();
      if (!exists) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "File upload verification failed. File not found in storage.",
        });
      }

      await withTransaction(async (session) => {
        // Upsert the blob registry: a new content hash inserts the blob, an
        // existing one (concurrent confirm or dedup hit) bumps the ref count.
        await File.updateOne(
          { _id: input.hash },
          {
            $setOnInsert: { size: input.size, path: input.hash },
            $inc: { refCount: 1 },
          },
          { upsert: true, session },
        );

        await Asset.create(
          [
            {
              name: input.filename,
              contentType: input.contentType ?? null,
              userId: userObjectId,
              folderId: input.folderId ? toObjectId(input.folderId) : null,
              fileHash: input.hash,
            },
          ],
          { session },
        );

        await adjustStorageUsed(userId, input.size, session);
      });

      return { success: true, message: "File uploaded and confirmed" };
    }),

  // ============================================
  // FILE MANAGEMENT
  // ============================================

  /**
   * List files and folders for the current user
   */
  listFiles: protectedProcedure
    .input(
      z
        .object({
          folderId: objectIdSchema.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);
      const folderObjectId = input?.folderId
        ? toObjectId(input.folderId)
        : null;

      // Files in the specified folder (or root), newest first, trash hidden.
      const assets = await Asset.find({
        userId: userObjectId,
        folderId: folderObjectId,
        deletedAt: null,
      })
        .sort({ createdAt: -1 })
        .lean();

      // Resolve the shared blobs in one query instead of per-asset lookups.
      const hashes = [...new Set(assets.map((asset) => asset.fileHash))];
      const blobs = await File.find({ _id: { $in: hashes } }).lean();
      const blobByHash = new Map(blobs.map((blob) => [blob._id, blob]));

      const formattedFiles = assets.map((asset) => {
        const blob = blobByHash.get(asset.fileHash);
        const refCount = blob?.refCount ?? 1;
        return {
          id: String(asset._id),
          name: asset.name,
          size: blob?.size ?? 0,
          contentType: asset.contentType,
          uploadDate: asset.createdAt,
          uploader: userId,
          isOriginal: refCount === 1,
          isDeduplicated: refCount > 1,
          refCount,
          isPublic: asset.isPublic,
          publicShareId: asset.publicShareId,
          downloadCount: asset.downloadCount,
        };
      });

      // Subfolders (trash hidden), newest first.
      const userFolders = await Folder.find({
        userId: userObjectId,
        parentId: folderObjectId,
        deletedAt: null,
      })
        .sort({ createdAt: -1 })
        .lean();

      return {
        files: formattedFiles,
        folders: userFolders.map(serializeFolder),
        currentFolderId: input?.folderId ?? null,
      };
    }),

  /**
   * Get file details
   */
  getFile: protectedProcedure
    .input(z.object({ id: objectIdSchema }))
    .query(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const asset = await Asset.findOne({
        _id: toObjectId(input.id),
        userId: toObjectId(userId),
        deletedAt: null,
      }).lean();

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      const blob = await File.findById(asset.fileHash).lean();
      if (!blob) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File content not found",
        });
      }

      const folder = asset.folderId
        ? await Folder.findById(asset.folderId).lean()
        : null;

      // Generate download URL
      const downloadUrl = s3.presign(blob.path, {
        expiresIn: 3600,
      });

      return {
        id: String(asset._id),
        name: asset.name,
        size: blob.size,
        contentType: asset.contentType,
        uploadDate: asset.createdAt,
        folder: folder ? serializeFolder(folder) : null,
        isOriginal: blob.refCount === 1,
        isDeduplicated: blob.refCount > 1,
        refCount: blob.refCount,
        isPublic: asset.isPublic,
        publicShareId: asset.publicShareId,
        downloadCount: asset.downloadCount,
        downloadUrl,
      };
    }),

  // ============================================
  // FOLDER MANAGEMENT
  // ============================================

  /**
   * List only folders (lightweight query for sidebar)
   */
  listFolders: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    const userFolders = await Folder.find({
      userId: toObjectId(userId),
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .lean();

    return userFolders.map(serializeFolder);
  }),

  /**
   * Create a new folder
   */
  createFolder: rateLimitedProcedure
    .input(
      z.object({
        name: filenameSchema,
        parentId: objectIdSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Verify parent folder exists and belongs to user if specified
      if (input.parentId) {
        const parentFolder = await Folder.findOne({
          _id: toObjectId(input.parentId),
          userId: userObjectId,
        }).lean();
        if (!parentFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Parent folder not found",
          });
        }
      }

      const folder = await Folder.create({
        name: input.name,
        parentId: input.parentId ? toObjectId(input.parentId) : null,
        userId: userObjectId,
      });

      return { success: true, folder: serializeFolder(folder.toObject()) };
    }),

  /**
   * Rename a folder
   */
  renameFolder: rateLimitedProcedure
    .input(
      z.object({
        id: objectIdSchema,
        name: filenameSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const updated = await Folder.findOneAndUpdate(
        { _id: toObjectId(input.id), userId: toObjectId(userId) },
        { name: input.name },
        { returnDocument: "after" },
      ).lean();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found",
        });
      }

      return { success: true, folder: serializeFolder(updated) };
    }),

  /**
   * Delete a folder (must be empty)
   */
  deleteFolder: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const folderId = toObjectId(input.id);

      // Check folder exists and belongs to user
      const folder = await Folder.findOne({
        _id: folderId,
        userId: toObjectId(userId),
      }).lean();

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found",
        });
      }

      // Check if folder has contents
      const hasFiles = await Asset.exists({ folderId });
      const hasSubfolders = await Folder.exists({ parentId: folderId });

      if (hasFiles || hasSubfolders) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Folder is not empty. Delete all contents first.",
        });
      }

      await Folder.deleteOne({ _id: folderId });

      return { success: true };
    }),

  /**
   * Move a folder to trash (soft delete - recursive)
   * Moves the folder and all its contents (files and subfolders) to trash
   */
  moveFolderToTrash: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);
      const now = new Date();

      // Check folder exists and belongs to user
      const folder = await Folder.findOne({
        _id: toObjectId(input.id),
        userId: userObjectId,
        deletedAt: null,
      }).lean();

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found or already in trash",
        });
      }

      // Collect the folder and every live descendant to trash.
      const folderIds = await collectSubtree(userObjectId, folder._id, {
        deletedAt: null,
      });

      await withTransaction(async (session) => {
        // Trash all live files in these folders.
        await Asset.updateMany(
          { userId: userObjectId, deletedAt: null, folderId: { $in: folderIds } },
          { $set: { deletedAt: now } },
          { session },
        );

        // Trash all folders in the subtree.
        await Folder.updateMany(
          { _id: { $in: folderIds } },
          { $set: { deletedAt: now } },
          { session },
        );
      });

      return {
        success: true,
        message: "Folder and contents moved to trash",
        trashedFolders: folderIds.length,
      };
    }),

  /**
   * Restore a folder from trash (recursive)
   * Restores the folder and all its contents
   */
  restoreFolderFromTrash: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Check folder exists and is in trash
      const folder = await Folder.findOne({
        _id: toObjectId(input.id),
        userId: userObjectId,
        deletedAt: { $ne: null },
      }).lean();

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found in trash",
        });
      }

      // Check if parent folder exists and is not trashed (if not root)
      if (folder.parentId) {
        const parentFolder = await Folder.findOne({
          _id: folder.parentId,
          userId: userObjectId,
        }).lean();

        if (!parentFolder) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Parent folder no longer exists",
          });
        }

        if (parentFolder.deletedAt) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Parent folder is in trash. Restore it first or restore this folder to root.",
          });
        }
      }

      // Collect the folder and every trashed descendant.
      const folderIds = await collectSubtree(userObjectId, folder._id, {
        deletedAt: { $ne: null },
      });

      await withTransaction(async (session) => {
        // Restore all files in these folders.
        await Asset.updateMany(
          {
            userId: userObjectId,
            deletedAt: { $ne: null },
            folderId: { $in: folderIds },
          },
          { $set: { deletedAt: null } },
          { session },
        );

        // Restore all folders in the subtree.
        await Folder.updateMany(
          { _id: { $in: folderIds } },
          { $set: { deletedAt: null } },
          { session },
        );
      });

      return {
        success: true,
        message: "Folder and contents restored from trash",
        restoredFolders: folderIds.length,
      };
    }),

  // ============================================
  // FILE DELETION
  // ============================================

  /**
   * Delete a file asset
   * Only the uploader can delete their own files
   * Actual S3 content only deleted when all references are gone
   */
  deleteAsset: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Find the asset - must belong to current user
      const asset = await Asset.findOne({
        _id: toObjectId(input.id),
        userId: toObjectId(userId),
      }).lean();

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found or you do not have permission to delete it",
        });
      }

      const blob = await File.findById(asset.fileHash).lean();
      const fileSize = blob?.size ?? 0;

      // Side effects (the R2 delete) are not transactional, so collect the blob
      // to remove and fire it only after the transaction commits.
      let blobToDelete: string | null = null;

      await withTransaction(async (session) => {
        const released = await releaseAsset(session, asset, fileSize);
        blobToDelete = released.blobToDelete;
        await adjustStorageUsed(userId, -released.freedBytes, session);
      });

      if (blobToDelete) {
        await s3.file(blobToDelete).delete();
      }

      return { success: true, message: "File deleted successfully" };
    }),

  // ============================================
  // TRASH MANAGEMENT
  // ============================================

  /**
   * Move a file to trash (soft delete)
   */
  moveToTrash: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const updated = await Asset.findOneAndUpdate(
        {
          _id: toObjectId(input.id),
          userId: toObjectId(userId),
          deletedAt: null,
        },
        { $set: { deletedAt: new Date() } },
        { returnDocument: "after" },
      ).lean();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found or already in trash",
        });
      }

      return { success: true, message: "File moved to trash" };
    }),

  /**
   * Restore a file from trash
   */
  restoreFromTrash: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const updated = await Asset.findOneAndUpdate(
        {
          _id: toObjectId(input.id),
          userId: toObjectId(userId),
          deletedAt: { $ne: null },
        },
        { $set: { deletedAt: null } },
        { returnDocument: "after" },
      ).lean();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found in trash",
        });
      }

      return { success: true, message: "File restored from trash" };
    }),

  /**
   * List files and folders in trash
   */
  listTrash: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    const userObjectId = toObjectId(userId);

    // Get trashed files
    const trashedAssets = await Asset.find({
      userId: userObjectId,
      deletedAt: { $ne: null },
    })
      .sort({ deletedAt: -1 })
      .lean();

    const hashes = [...new Set(trashedAssets.map((asset) => asset.fileHash))];
    const blobs = await File.find({ _id: { $in: hashes } }).lean();
    const blobByHash = new Map(blobs.map((blob) => [blob._id, blob]));

    // Get trashed folders (only top-level trashed folders - those whose parent
    // is not trashed or is null)
    const allTrashedFolders = await Folder.find({
      userId: userObjectId,
      deletedAt: { $ne: null },
    })
      .sort({ deletedAt: -1 })
      .lean();

    const trashedFolderIds = new Set(
      allTrashedFolders.map((folder) => String(folder._id)),
    );
    const topLevelTrashedFolders = allTrashedFolders.filter((folder) => {
      if (!folder.parentId) return true;
      if (!trashedFolderIds.has(String(folder.parentId))) return true;
      return false;
    });

    const files = trashedAssets.map((asset) => ({
      id: String(asset._id),
      type: "file" as const,
      name: asset.name,
      size: blobByHash.get(asset.fileHash)?.size ?? 0,
      deletedAt: asset.deletedAt,
      uploadDate: asset.createdAt,
    }));

    const trashedFolders = topLevelTrashedFolders.map((folder) => ({
      id: String(folder._id),
      type: "folder" as const,
      name: folder.name,
      deletedAt: folder.deletedAt,
      createdAt: folder.createdAt,
    }));

    return {
      files,
      folders: trashedFolders,
    };
  }),

  /**
   * Permanently delete a file from trash
   */
  permanentlyDelete: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Find the asset in trash
      const asset = await Asset.findOne({
        _id: toObjectId(input.id),
        userId: toObjectId(userId),
        deletedAt: { $ne: null },
      }).lean();

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found in trash",
        });
      }

      const blob = await File.findById(asset.fileHash).lean();
      const fileSize = blob?.size ?? 0;
      let blobToDelete: string | null = null;

      await withTransaction(async (session) => {
        const released = await releaseAsset(session, asset, fileSize);
        blobToDelete = released.blobToDelete;
        await adjustStorageUsed(userId, -released.freedBytes, session);
      });

      if (blobToDelete) {
        await s3.file(blobToDelete).delete();
      }

      return { success: true, message: "File permanently deleted" };
    }),

  /**
   * Permanently delete a folder from trash (recursive)
   * Deletes the folder and all its contents permanently
   */
  permanentlyDeleteFolder: rateLimitedProcedure
    .input(z.object({ id: objectIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Find the folder in trash
      const folder = await Folder.findOne({
        _id: toObjectId(input.id),
        userId: userObjectId,
        deletedAt: { $ne: null },
      }).lean();

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found in trash",
        });
      }

      // Collect the folder and every descendant, trashed or not.
      const folderIds = await collectSubtree(userObjectId, folder._id, {});

      // Get all files in these folders.
      const assetsInFolders = await Asset.find({
        userId: userObjectId,
        folderId: { $in: folderIds },
      }).lean();

      const hashes = [
        ...new Set(assetsInFolders.map((asset) => asset.fileHash)),
      ];
      const blobs = await File.find({ _id: { $in: hashes } }).lean();
      const blobByHash = new Map(blobs.map((blob) => [blob._id, blob]));

      let totalFreedBytes = 0;
      const blobsToDelete: string[] = [];

      await withTransaction(async (session) => {
        // Delete every claim in the subtree and release its blob reference.
        for (const asset of assetsInFolders) {
          const released = await releaseAsset(
            session,
            asset,
            blobByHash.get(asset.fileHash)?.size ?? 0,
          );
          totalFreedBytes += released.freedBytes;
          if (released.blobToDelete) blobsToDelete.push(released.blobToDelete);
        }

        // Delete all folders. No foreign keys, so order does not matter.
        await Folder.deleteMany({ _id: { $in: folderIds } }, { session });

        await adjustStorageUsed(userId, -totalFreedBytes, session);
      });

      for (const key of blobsToDelete) {
        await s3.file(key).delete();
      }

      return {
        success: true,
        message: "Folder and contents permanently deleted",
        deletedFiles: assetsInFolders.length,
        deletedFolders: folderIds.length,
        freedBytes: totalFreedBytes,
        freedBytesFormatted: formatBytes(totalFreedBytes),
      };
    }),

  /**
   * Empty entire trash (permanently delete all trashed files and folders)
   */
  emptyTrash: rateLimitedProcedure.mutation(async ({ ctx }) => {
    const userId = getUserId(ctx);
    const userObjectId = toObjectId(userId);

    // Get all trashed assets
    const trashedAssets = await Asset.find({
      userId: userObjectId,
      deletedAt: { $ne: null },
    }).lean();

    // Get all trashed folders
    const trashedFolders = await Folder.find({
      userId: userObjectId,
      deletedAt: { $ne: null },
    }).lean();

    if (trashedAssets.length === 0 && trashedFolders.length === 0) {
      return {
        success: true,
        deletedFiles: 0,
        deletedFolders: 0,
        message: "Trash is already empty",
      };
    }

    const hashes = [...new Set(trashedAssets.map((asset) => asset.fileHash))];
    const blobs = await File.find({ _id: { $in: hashes } }).lean();
    const blobByHash = new Map(blobs.map((blob) => [blob._id, blob]));

    let totalFreedBytes = 0;
    const blobsToDelete: string[] = [];

    await withTransaction(async (session) => {
      // Delete all trashed files.
      for (const asset of trashedAssets) {
        const released = await releaseAsset(
          session,
          asset,
          blobByHash.get(asset.fileHash)?.size ?? 0,
        );
        totalFreedBytes += released.freedBytes;
        if (released.blobToDelete) blobsToDelete.push(released.blobToDelete);
      }

      // Delete all trashed folders.
      await Folder.deleteMany(
        { _id: { $in: trashedFolders.map((folder) => folder._id) } },
        { session },
      );

      await adjustStorageUsed(userId, -totalFreedBytes, session);
    });

    for (const key of blobsToDelete) {
      await s3.file(key).delete();
    }

    return {
      success: true,
      deletedFiles: trashedAssets.length,
      deletedFolders: trashedFolders.length,
      freedBytes: totalFreedBytes,
      freedBytesFormatted: formatBytes(totalFreedBytes),
      message: `Permanently deleted ${trashedAssets.length} file(s) and ${trashedFolders.length} folder(s)`,
    };
  }),

  /**
   * Rename a file
   */
  renameFile: rateLimitedProcedure
    .input(
      z.object({
        id: objectIdSchema,
        name: filenameSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const updated = await Asset.findOneAndUpdate(
        { _id: toObjectId(input.id), userId: toObjectId(userId) },
        { name: input.name },
        { returnDocument: "after" },
      ).lean();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      return { success: true, asset: serializeAsset(updated) };
    }),

  /**
   * Move a file to a different folder
   */
  moveFile: rateLimitedProcedure
    .input(
      z.object({
        id: objectIdSchema,
        folderId: objectIdSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Verify target folder if specified
      if (input.folderId) {
        const targetFolder = await Folder.findOne({
          _id: toObjectId(input.folderId),
          userId: userObjectId,
        }).lean();
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }
      }

      const updated = await Asset.findOneAndUpdate(
        { _id: toObjectId(input.id), userId: userObjectId },
        {
          $set: {
            folderId: input.folderId ? toObjectId(input.folderId) : null,
          },
        },
        { returnDocument: "after" },
      ).lean();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      return { success: true };
    }),

  /**
   * Move multiple files to a different folder
   */
  moveFiles: rateLimitedProcedure
    .input(
      z.object({
        ids: z
          .array(objectIdSchema)
          .max(100, "Cannot move more than 100 files at once"),
        folderId: objectIdSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Verify target folder if specified
      if (input.folderId) {
        const targetFolder = await Folder.findOne({
          _id: toObjectId(input.folderId),
          userId: userObjectId,
          deletedAt: null,
        }).lean();
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }
      }

      const result = await Asset.updateMany(
        {
          _id: { $in: input.ids.map((id) => toObjectId(id)) },
          userId: userObjectId,
        },
        {
          $set: {
            folderId: input.folderId ? toObjectId(input.folderId) : null,
          },
        },
      );

      return { success: true, movedCount: result.modifiedCount };
    }),

  /**
   * Move a folder to a different parent folder
   */
  moveFolder: rateLimitedProcedure
    .input(
      z.object({
        id: objectIdSchema,
        parentId: objectIdSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Get the folder being moved
      const folder = await Folder.findOne({
        _id: toObjectId(input.id),
        userId: userObjectId,
        deletedAt: null,
      }).lean();

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found",
        });
      }

      // Cannot move folder to itself
      if (input.parentId === input.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot move folder to itself",
        });
      }

      // Verify target folder if specified
      if (input.parentId) {
        const targetFolder = await Folder.findOne({
          _id: toObjectId(input.parentId),
          userId: userObjectId,
          deletedAt: null,
        }).lean();
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }

        // Check for circular reference - target cannot be a descendant.
        if (await isDescendant(input.id, input.parentId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot move folder into its own subfolder",
          });
        }
      }

      const updated = await Folder.findOneAndUpdate(
        { _id: folder._id },
        { $set: { parentId: input.parentId ? toObjectId(input.parentId) : null } },
        { returnDocument: "after" },
      ).lean();

      return { success: true, folder: updated ? serializeFolder(updated) : null };
    }),

  /**
   * Move multiple folders to a different parent folder
   */
  moveFolders: rateLimitedProcedure
    .input(
      z.object({
        ids: z
          .array(objectIdSchema)
          .max(100, "Cannot move more than 100 folders at once"),
        parentId: objectIdSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const userObjectId = toObjectId(userId);

      // Verify target folder if specified
      if (input.parentId) {
        const targetFolder = await Folder.findOne({
          _id: toObjectId(input.parentId),
          userId: userObjectId,
          deletedAt: null,
        }).lean();
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }
      }

      let movedCount = 0;
      for (const id of input.ids) {
        // Skip if trying to move to itself
        if (input.parentId === id) continue;

        // Skip if target is a descendant of this folder
        if (input.parentId && (await isDescendant(id, input.parentId))) continue;

        const folder = await Folder.findOne({
          _id: toObjectId(id),
          userId: userObjectId,
          deletedAt: null,
        }).lean();

        if (folder) {
          await Folder.updateOne(
            { _id: folder._id },
            {
              $set: {
                parentId: input.parentId ? toObjectId(input.parentId) : null,
              },
            },
          );
          movedCount++;
        }
      }

      return { success: true, movedCount };
    }),

  // ============================================
  // SHARING
  // ============================================

  /**
   * Toggle public sharing for a file
   */
  togglePublic: rateLimitedProcedure
    .input(
      z.object({
        id: objectIdSchema,
        isPublic: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Generate or clear share ID
      const publicShareId = input.isPublic ? crypto.randomUUID() : null;

      const updated = await Asset.findOneAndUpdate(
        { _id: toObjectId(input.id), userId: toObjectId(userId) },
        {
          $set: {
            isPublic: input.isPublic,
            publicShareId,
          },
        },
        { returnDocument: "after" },
      ).lean();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      return {
        success: true,
        isPublic: updated.isPublic,
        shareUrl: updated.publicShareId
          ? `/share/${updated.publicShareId}`
          : null,
      };
    }),

  /**
   * Get public file by share ID (no auth required)
   * Increments download count
   */
  getPublicFile: publicProcedure
    .input(z.object({ shareId: z.string().uuid() }))
    .query(async ({ input }) => {
      const asset = await Asset.findOne({
        publicShareId: input.shareId,
        isPublic: true,
      }).lean();

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found or is not publicly shared",
        });
      }

      const blob = await File.findById(asset.fileHash).lean();
      if (!blob) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File content not found",
        });
      }

      // Increment download count
      await Asset.updateOne(
        { _id: asset._id },
        { $inc: { downloadCount: 1 } },
      );

      // Generate download URL
      const downloadUrl = s3.presign(blob.path, {
        expiresIn: 3600,
      });

      return {
        id: String(asset._id),
        name: asset.name,
        size: blob.size,
        contentType: asset.contentType,
        downloadCount: asset.downloadCount + 1, // Include current download
        uploadDate: asset.createdAt,
        downloadUrl,
      };
    }),

  // ============================================
  // STATISTICS
  // ============================================

  /**
   * Get storage statistics for the current user
   *
   * One aggregation pipeline computes logical size, file counts, and the
   * deduplicated (physical) size in a single round trip using `$facet`:
   *  - `totals` sums every asset's blob size (what the user uploaded);
   *  - `unique` collapses assets by hash first, so each unique blob is counted
   *    once (what the dedup actually costs).
   */
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    const userObjectId = toObjectId(userId);

    const quota = await readQuota(userObjectId);

    const [result] = await Asset.aggregate<{
      totals: {
        originalSize: number;
        totalFiles: number;
        dedupedFiles: number;
      }[];
      unique: { uniqueSize: number }[];
    }>([
      { $match: { userId: userObjectId } },
      {
        $lookup: {
          from: "files",
          localField: "fileHash",
          foreignField: "_id",
          as: "file",
        },
      },
      { $unwind: "$file" },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                originalSize: { $sum: "$file.size" },
                totalFiles: { $sum: 1 },
                dedupedFiles: {
                  $sum: { $cond: [{ $gt: ["$file.refCount", 1] }, 1, 0] },
                },
              },
            },
          ],
          unique: [
            {
              $group: {
                _id: "$fileHash",
                size: { $first: "$file.size" },
              },
            },
            { $group: { _id: null, uniqueSize: { $sum: "$size" } } },
          ],
        },
      },
    ]);

    const totals = result?.totals?.[0];
    const storageUsed = quota.storageUsed;
    const storageLimit = quota.storageLimit;
    const totalOriginalSize = Number(totals?.originalSize ?? 0);
    const actualStorageUsed = Number(result?.unique?.[0]?.uniqueSize ?? 0);
    const savedBytes = totalOriginalSize - actualStorageUsed;
    const savedPercent =
      totalOriginalSize > 0 ? (savedBytes / totalOriginalSize) * 100 : 0;

    return {
      // Quota info
      storageUsed,
      storageLimit,
      storageUsedFormatted: formatBytes(storageUsed),
      storageLimitFormatted: formatBytes(storageLimit),
      usagePercent: (storageUsed / storageLimit) * 100,

      // File counts
      totalFiles: Number(totals?.totalFiles ?? 0),
      dedupedFiles: Number(totals?.dedupedFiles ?? 0),

      // Deduplication savings
      originalSize: totalOriginalSize,
      actualStorageUsed,
      savedBytes,
      savedPercent,
      originalSizeFormatted: formatBytes(totalOriginalSize),
      actualStorageUsedFormatted: formatBytes(actualStorageUsed),
      savedBytesFormatted: formatBytes(savedBytes),

      // Rate limit
      rateLimit: quota.rateLimit ?? DEFAULT_RATE_LIMIT,
    };
  }),

  /**
   * Get quota settings (admin use or display)
   */
  getQuota: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    const quota = await ensureQuota(toObjectId(userId));

    return {
      storageUsed: quota.storageUsed,
      storageLimit: quota.storageLimit,
      storageUsedFormatted: formatBytes(quota.storageUsed),
      storageLimitFormatted: formatBytes(quota.storageLimit),
      usagePercent: (quota.storageUsed / quota.storageLimit) * 100,
      rateLimit: quota.rateLimit ?? DEFAULT_RATE_LIMIT,
    };
  }),

  // ============================================
  // AVATAR UPLOAD
  // ============================================

  /**
   * Get presigned URL for avatar upload
   * Avatars are stored in avatars/ prefix with user ID as key
   */
  getAvatarUploadUrl: rateLimitedProcedure
    .input(
      z.object({
        contentType: z.string().regex(/^image\/(jpeg|png|gif|webp)$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const key = `avatars/${userId}`;

      const url = s3.presign(key, {
        method: "PUT",
        expiresIn: 3600,
        type: input.contentType,
      });

      return {
        url,
        key,
        avatarUrl: env.R2_PUBLIC_URL ? `${env.R2_PUBLIC_URL}/${key}` : null,
      };
    }),

  /**
   * Get presigned URL for viewing the current user's avatar
   * Returns a presigned download URL for the user's avatar
   */
  getAvatarUrl: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    const key = `avatars/${userId}`;

    // The avatar is optional and object storage may be unreachable or not yet
    // configured. A missing avatar must never break the dashboard, so any
    // storage error degrades to "no avatar".
    try {
      const exists = await s3.file(key).exists();
      if (!exists) {
        return { avatarUrl: null };
      }

      // Generate presigned URL for viewing (1 hour expiry)
      const avatarUrl = s3.presign(key, {
        expiresIn: 3600,
      });

      return { avatarUrl };
    } catch {
      return { avatarUrl: null };
    }
  }),
});
