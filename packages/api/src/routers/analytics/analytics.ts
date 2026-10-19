import {
  Asset,
  File,
  Folder,
  toObjectId,
} from "@nexdrive/db";
import { router, protectedProcedure } from "../../index";

/**
 * Analytics router — the aggregation pipelines behind the Insights page.
 *
 * These are read-only reporting queries that lean on MongoDB-specific features
 * the CRUD routes do not exercise: `$facet`, `$lookup` + `$unwind`, `$group`
 * over a date expression, and `$graphLookup` for walking the folder tree.
 */
export const analyticsRouter = router({
  /**
   * System-wide deduplication report.
   *
   * `logicalBytes` is what storage would cost if every claim kept its own copy;
   * `physicalBytes` is what the blob registry actually stores. The difference is
   * the storage dedup saved. `$facet` computes the totals and the most-shared
   * blobs in one pass over `files`.
   */
  dedupReport: protectedProcedure.query(async () => {
    const [result] = await File.aggregate<{
      totals: {
        physicalBytes: number;
        logicalBytes: number;
        blobs: number;
        claims: number;
      }[];
      topDuplicated: {
        hash: string;
        size: number;
        refCount: number;
        wastedBytes: number;
      }[];
    }>([
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                physicalBytes: { $sum: "$size" },
                logicalBytes: { $sum: { $multiply: ["$size", "$refCount"] } },
                blobs: { $sum: 1 },
                claims: { $sum: "$refCount" },
              },
            },
          ],
          topDuplicated: [
            { $match: { refCount: { $gt: 1 } } },
            { $sort: { refCount: -1, size: -1 } },
            { $limit: 10 },
            {
              $project: {
                _id: 0,
                hash: "$_id",
                size: 1,
                refCount: 1,
                wastedBytes: {
                  $multiply: ["$size", { $subtract: ["$refCount", 1] }],
                },
              },
            },
          ],
        },
      },
    ]);

    const totals = result?.totals?.[0];
    const physicalBytes = Number(totals?.physicalBytes ?? 0);
    const logicalBytes = Number(totals?.logicalBytes ?? 0);
    const savedBytes = logicalBytes - physicalBytes;

    return {
      blobs: Number(totals?.blobs ?? 0),
      claims: Number(totals?.claims ?? 0),
      physicalBytes,
      logicalBytes,
      savedBytes,
      savedPercent: logicalBytes > 0 ? (savedBytes / logicalBytes) * 100 : 0,
      dedupRatio: physicalBytes > 0 ? logicalBytes / physicalBytes : 1,
      topDuplicated: result?.topDuplicated ?? [],
    };
  }),

  /**
   * Storage breakdown by content type for the current user.
   */
  storageByType: protectedProcedure.query(async ({ ctx }) => {
    const userObjectId = toObjectId(ctx.session.user.id);

    const rows = await Asset.aggregate<{
      contentType: string;
      files: number;
      bytes: number;
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
        $group: {
          _id: { $ifNull: ["$contentType", "unknown"] },
          files: { $sum: 1 },
          bytes: { $sum: "$file.size" },
        },
      },
      { $project: { _id: 0, contentType: "$_id", files: 1, bytes: 1 } },
      { $sort: { bytes: -1 } },
    ]);

    return rows;
  }),

  /**
   * Upload activity for the current user, bucketed by day.
   */
  uploadActivity: protectedProcedure.query(async ({ ctx }) => {
    const userObjectId = toObjectId(ctx.session.user.id);

    const rows = await Asset.aggregate<{
      date: string;
      files: number;
      bytes: number;
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
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          files: { $sum: 1 },
          bytes: { $sum: "$file.size" },
        },
      },
      { $project: { _id: 0, date: "$_id", files: 1, bytes: 1 } },
      { $sort: { date: 1 } },
    ]);

    return rows;
  }),

  /**
   * Most-downloaded public files, across all users.
   *
   * `$lookup` joins the blob for its size and the owner for their name; the two
   * joins happen before the projection so the whole report is one round trip.
   */
  topShared: protectedProcedure.query(async () => {
    const rows = await Asset.aggregate<{
      id: string;
      name: string;
      downloadCount: number;
      size: number;
      contentType: string | null;
      owner: string | null;
    }>([
      { $match: { isPublic: true } },
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
        $lookup: {
          from: "user",
          localField: "userId",
          foreignField: "_id",
          as: "owner",
        },
      },
      { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
      { $sort: { downloadCount: -1 } },
      { $limit: 10 },
      {
        $project: {
          _id: 0,
          id: { $toString: "$_id" },
          name: 1,
          downloadCount: 1,
          size: "$file.size",
          contentType: 1,
          owner: "$owner.name",
        },
      },
    ]);

    return rows;
  }),

  /**
   * Folder tree for the current user, with depth and subtree size.
   *
   * Two `$graphLookup` passes: one walks *up* the `parentId` chain to measure
   * depth, the other walks *down* to count descendants. This is the document
   * database's answer to graph traversal — no recursive application code needed.
   */
  folderTree: protectedProcedure.query(async ({ ctx }) => {
    const userObjectId = toObjectId(ctx.session.user.id);

    const rows = await Folder.aggregate<{
      id: string;
      name: string;
      parentId: string | null;
      depth: number;
      descendants: number;
    }>([
      { $match: { userId: userObjectId, deletedAt: null } },
      {
        $graphLookup: {
          from: "folders",
          startWith: "$parentId",
          connectFromField: "parentId",
          connectToField: "_id",
          as: "ancestors",
          depthField: "depth",
          restrictSearchWithMatch: { deletedAt: null },
        },
      },
      {
        $graphLookup: {
          from: "folders",
          startWith: "$_id",
          connectFromField: "_id",
          connectToField: "parentId",
          as: "descendants",
          restrictSearchWithMatch: { deletedAt: null },
        },
      },
      {
        $project: {
          _id: 0,
          id: { $toString: "$_id" },
          name: 1,
          parentId: { $toString: "$parentId" },
          depth: { $size: "$ancestors" },
          descendants: { $size: "$descendants" },
        },
      },
      { $sort: { depth: 1, name: 1 } },
    ]);

    return rows;
  }),

  /**
   * Storage leaderboard across all users.
   *
   * Groups every claim by owner, then joins the profile and counts the distinct
   * blobs each user holds — the gap between `files` and `uniqueFiles` is that
   * user's dedup exposure.
   */
  topUsers: protectedProcedure.query(async () => {
    const rows = await Asset.aggregate<{
      userId: string;
      name: string | null;
      files: number;
      uniqueFiles: number;
      logicalBytes: number;
    }>([
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
        $group: {
          _id: "$userId",
          files: { $sum: 1 },
          logicalBytes: { $sum: "$file.size" },
          uniqueHashes: { $addToSet: "$fileHash" },
        },
      },
      {
        $lookup: {
          from: "user",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          userId: { $toString: "$_id" },
          name: "$user.name",
          files: 1,
          uniqueFiles: { $size: "$uniqueHashes" },
          logicalBytes: 1,
        },
      },
      { $sort: { logicalBytes: -1 } },
      { $limit: 10 },
    ]);

    return rows;
  }),
});
