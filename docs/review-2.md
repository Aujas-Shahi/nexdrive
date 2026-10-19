# NexDrive — Review 2

## Database Implementation & Core Functionalities

This document covers the implementation of _NexDrive_ on MongoDB: the collections as built, the sample dataset loaded, the CRUD surface, and the advanced NoSQL features (indexing, multi-document transactions, aggregation pipelines, and graph traversal) that carry the review. It assumes the design fixed in Review 1 (`docs/review-1.md`).

**Source repository:** https://github.com/Siddhj2206/NexDrive

---

## 1. Implementation Overview

NexDrive is a self-hosted cloud storage platform with content-addressed deduplication. Review 1 fixed the design; Review 2 is the running implementation.

| Layer | Technology | Version |
|-------|------------|---------|
| Runtime | Bun | 1.4 |
| Database | **MongoDB** (single-node replica set `rs0`) | 7 |
| ODM | **Mongoose** | 9 |
| Backend | Hono + tRPC | 4.13 / 11.19 |
| Auth | Better Auth (MongoDB adapter) | 1.7 |
| Frontend | React + TanStack Router/Query, Tailwind, shadcn/ui | 19.3 |
| Object storage | Cloudflare R2 (S3-compatible, presigned URLs) | — |
| Monorepo | Turborepo | 2.11 |

The database holds **metadata only**. File content lives in a private R2 bucket under its SHA-256 hash as the object key — the same hash that is `files._id`.

### Running it

```bash
bun install
bun run db:up      # start MongoDB (podman replica set rs0)
bun run db:seed    # load the sample dataset
bun run dev        # web on :3001, API on :3000
```

Demo login: **`alice@nexdrive.test` / `password123`** (every seeded user shares this password).

> **Why a replica set?** Multi-document transactions — the backbone of the dedup ref-counting and quota flows — require one. `scripts/mongo.sh` starts a single-node replica set (`rs0`) with podman and initiates it.

---

## 2. Database Implementation

### 2.1 Collections

Eight collections are created. Review 1 called for a minimum of five.

| Collection | Role | Documents seeded |
|------------|------|-----------------:|
| `user` | Profile with **embedded** `quota` | 6 |
| `session` | Better Auth session records | 2 |
| `account` | Credential accounts (scrypt password hash) | 6 |
| `verification` | Email-verification tokens | 2 |
| `files` | Content-addressable blob registry — `_id` **is** the SHA-256 hash | 30 |
| `folders` | Adjacency-list folder tree (`parentId`) | 20 |
| `assets` | One document per user-file claim | 57 |
| `rate_limit_windows` | Ephemeral rate-limit counters (TTL) | 4 |
| **Total** | | **127** |

The rubric's floor is 50 records; the technical minimum is 100. The seed loads **127**.

### 2.2 Relationships

The entity model is unchanged from Review 1 §4.1. Every relationship is a reference field resolved in application code — there are no joins.

```
USER ──1:1──> QUOTA            (embedded in the user document)
USER ──1:N──> SESSION / ACCOUNT / VERIFICATION
USER ──1:N──> FOLDER ──parent(0..1)──> FOLDER   (self-referencing tree)
USER ──1:N──> ASSET
FOLDER ──1:N──> ASSET
FILE  ──1:N──> ASSET            (asset references one blob by hash)
USER ──1:N──> RATE_LIMIT_WINDOW
```

Two deliberate choices carry the design:

- **The quota is embedded**, not a separate collection. It is 1:1, tiny, and read on nearly every request, so it updates atomically with the owning user via `$inc`.
- **`assets` owns everything per-user.** The shared blob lives in `files`; the visible name, folder, sharing state, download count, and trash timestamp live on the asset. Every per-user view is therefore a single-collection `find`.

### 2.3 Schema highlights

Full Mongoose schemas are in Review 1 §4.4; the implementation matches them. The essentials:

```ts
// files — the content-addressable blob registry
const fileSchema = new Schema<FileDoc>({
  _id: { type: String },                 // SHA-256 hash = primary key
  size: { type: Number, required: true },
  path: { type: String, required: true }, // object key in R2
  refCount: { type: Number, default: 1 },
}, { timestamps: true, versionKey: false, collection: "files" });
```

```ts
// assets — one document per user-file claim
const assetSchema = new Schema<AssetDoc>({
  name: { type: String, required: true },
  contentType: { type: String, default: null },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  folderId: { type: Schema.Types.ObjectId, ref: "Folder", default: null },
  fileHash: { type: String, required: true },   // -> files._id
  isPublic: { type: Boolean, default: false },
  publicShareId: { type: String, default: null },
  downloadCount: { type: Number, default: 0 },
  deletedAt: { type: Date, default: null },     // soft delete → trash
}, { timestamps: true, collection: "assets" });
```

> **ID conventions.** Better Auth's MongoDB adapter generates ObjectIds for the auth collections; `folders._id` and `assets._id` are ObjectIds, and `userId` / `folderId` / `parentId` are ObjectId references. The one exception is `files._id`, which is the SHA-256 **string** because it is the content hash by definition.

### 2.4 Sample dataset

`bun run db:seed` loads a reproducible dataset built around the Alice/Bob dedup scenario from Review 1, extended to exercise every collection and every feature. The seed:

1. clears all eight collections,
2. builds the full index set,
3. inserts 127 documents,
4. reports the totals and the dedup ratio.

```
seeded NexDrive sample data:
  users        6
  accounts     6
  sessions     2
  verifications 2
  folders      20
  files        30 unique blobs
  assets       57 claims
  rate windows 4
  total        127 documents

  dedup: 57 claims over 30 blobs — 8188.1 MB logical vs 3917.8 MB physical
```

The dataset covers: nested folders, root-level files, a shared 1 GB trailer (`refCount: 2`), a 1.5 GB archive, trashed files, a trashed folder with its contents, public shares with download counts, and per-user quotas. All demo users carry a 5 GB quota so the full set fits.

---

## 3. CRUD Operations

The API exposes **34 tRPC procedures** across two routers: 28 storage procedures and 6 analytics procedures. Every procedure is typed end to end (Zod in, TypeScript out), so the React client cannot call one with the wrong shape.

### 3.1 Storage router (`packages/api/src/routers/storage/storage.ts`)

| Operation | Procedures |
|-----------|------------|
| **Create** | `createFolder`, `confirmUpload`, `getUploadPresignedUrl` (creates an asset on a dedup hit) |
| **Read** | `listFiles`, `getFile`, `listFolders`, `listTrash`, `getStats`, `getQuota`, `getPublicFile` (no auth), `getAvatarUrl` |
| **Update** | `renameFolder`, `renameFile`, `moveFile`, `moveFiles`, `moveFolder`, `moveFolders`, `moveToTrash`, `restoreFromTrash`, `moveFolderToTrash`, `restoreFolderFromTrash`, `togglePublic`, `getAvatarUploadUrl` |
| **Delete** | `deleteFolder`, `deleteAsset`, `permanentlyDelete`, `permanentlyDeleteFolder`, `emptyTrash` |

### 3.2 Representative operations in code-shaped terms

```ts
// Upload, hash check — one point-read decides dedup vs. new blob
const existingFile = await File.findById(input.hash).lean();

// List a folder — single-collection query, newest first, trash hidden
const assets = await Asset.find({ userId, folderId, deletedAt: null })
  .sort({ createdAt: -1 }).lean();

// Delete an asset — transaction: drop the claim, decrement the blob, adjust quota
await withTransaction(async (session) => {
  const released = await releaseAsset(session, asset, fileSize);
  await adjustStorageUsed(userId, -released.freedBytes, session);
});
if (released.blobToDelete) await s3.file(released.blobToDelete).delete();
```

### 3.3 Deduplication in one paragraph

The client computes the SHA-256 hash before uploading. The server does a single point-read (`File.findById(hash)`). If the hash exists, **no content is re-uploaded** — a new `asset` is inserted, `files.refCount` is incremented, and the quota is charged (dedup saves physical storage, not the user's logical quota). If it does not exist, the content goes to R2 under the hash and a new blob document is created. A blob leaves R2 only when its last reference is gone.

---

## 4. Advanced NoSQL Features

This is the section the review weights most (5 marks): indexing, transactions, aggregation, and graph traversal.

### 4.1 Indexing

**11 indexes** beyond the default `_id` indexes. The rubric asks for two.

| Collection | Index | Purpose |
|------------|-------|---------|
| `user` | `{ email: 1 }` unique | one account per email |
| `files` | `{ refCount: 1 }` | sweep the blob registry by reference count |
| `folders` | `{ userId, parentId, deletedAt }` | folder listing |
| `folders` | `{ userId, deletedAt }` | trash listing |
| `folders` | `{ parentId }` | recursive tree walks |
| `assets` | `{ userId, folderId, deletedAt }` | folder listing |
| `assets` | `{ userId, deletedAt, createdAt: -1 }` | trash listing, newest-deleted first |
| `assets` | `{ userId, fileHash }` | per-user dedup statistics |
| `assets` | `{ publicShareId }` **unique, partial** | share-link lookup; partial so `null` share ids don't collide |
| `rate_limit_windows` | `{ userId, windowStart }` unique | the counter for a user in a window |
| `rate_limit_windows` | `{ createdAt }` **TTL 60 s** | stale windows expire with no cleanup job |

The TTL index is the interesting one: it lets the rate limiter write high-churn documents and never run a reaper. Verified live:

```
assets              :: publicShareId_1           [UNIQUE, partial]
rate_limit_windows  :: userId_1_windowStart_1    [UNIQUE]
rate_limit_windows  :: createdAt_1               [TTL=60]
```

### 4.2 Multi-document transactions

Eight operations touch more than one collection and run inside `session.withTransaction`. This is what keeps `files.refCount`, the `assets` claims, and the embedded quota from tearing.

| Operation | Writes wrapped |
|-----------|----------------|
| Upload (new content) | `files.insert` + `assets.insert` + `user.$inc quota` |
| Upload (dedup hit) | `assets.insert` + `files.$inc refCount` + `user.$inc quota` |
| Delete asset | `assets.delete` + `files.$inc refCount` (+ drop blob at zero) + quota |
| Trash / restore a folder | subtree `assets.updateMany` + subtree `folders.updateMany` |
| Permanent delete (file) | `assets.delete` + `files.$inc refCount` + quota |
| Permanent delete (folder) | every claim in the subtree + folder deletes + quota |
| Empty trash | every trashed claim + folder deletes + quota |

Object storage is **not** transactional, so blob deletion is a compensating action: the transaction records the key to remove, and the R2 delete fires only after the commit.

### 4.3 Aggregation pipelines

The analytics router (`packages/api/src/routers/analytics/analytics.ts`) exposes **six** pipelines; `getStats` adds a seventh. The rubric asks for five.

| Procedure | Pipeline highlights |
|-----------|---------------------|
| `analytics.dedupReport` | `$facet` — system-wide logical vs physical bytes, saved %, ratio, most-duplicated blobs |
| `analytics.storageByType` | `$lookup` + `$group` by content type for the current user |
| `analytics.uploadActivity` | `$group` over `$dateToString` — files and bytes per day |
| `analytics.topShared` | two `$lookup`s + `$sort` + `$limit` — most-downloaded public files |
| `analytics.folderTree` | two `$graphLookup`s — folder depth and subtree size |
| `analytics.topUsers` | `$group` + `$lookup` + `$size` — storage leaderboard |
| `storage.getStats` | `$facet` — logical size, file counts, and unique (deduped) size in one pass |

**Query 1 — global deduplication report.** The headline aggregation. `$facet` computes the totals and the most-duplicated blobs in one pass over `files`.

```js
db.files.aggregate([
  { $facet: {
      totals: [
        { $group: {
            _id: null,
            physicalBytes: { $sum: "$size" },
            logicalBytes: { $sum: { $multiply: ["$size", "$refCount"] } },
            blobs: { $sum: 1 },
            claims: { $sum: "$refCount" },
        }},
      ],
      topDuplicated: [
        { $match: { refCount: { $gt: 1 } } },
        { $sort: { refCount: -1, size: -1 } },
        { $limit: 10 },
        { $project: {
            hash: "$_id", size: 1, refCount: 1,
            wastedBytes: { $multiply: ["$size", { $subtract: ["$refCount", 1] }] },
        }},
      ],
  }},
])
```

Live output:

```
blobs: 30 | claims: 57
logical 8188.1 MB vs physical 3917.8 MB → saved 4270.4 MB (52.2%), ratio 2.09×
most duplicated blobs:
  1c2e5f1c5453… size 500.0 MB × 3 claims
  690803448f4d… size 120.0 MB × 3 claims
  616fcb00b02c… size 45.0 MB × 3 claims
```

**Query 2 — storage by content type.** `$lookup` joins the blob for its size, then `$group` buckets by MIME type:

```js
{ $match: { userId } },
{ $lookup: { from: "files", localField: "fileHash", foreignField: "_id", as: "file" } },
{ $unwind: "$file" },
{ $group: { _id: { $ifNull: ["$contentType", "unknown"] },
            files: { $sum: 1 }, bytes: { $sum: "$file.size" } } },
{ $sort: { bytes: -1 } }
```

**Query 3 — upload activity over time.** Files and bytes per day, using `$dateToString` to bucket the timestamps:

```js
{ $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            files: { $sum: 1 }, bytes: { $sum: "$file.size" } } },
{ $sort: { _id: 1 } }
```

**Query 4 — most-downloaded public files.** Two joins (blob size, owner name), then sort and limit:

```js
{ $match: { isPublic: true } },
{ $lookup: { from: "files", localField: "fileHash", foreignField: "_id", as: "file" } },
{ $unwind: "$file" },
{ $lookup: { from: "user", localField: "userId", foreignField: "_id", as: "owner" } },
{ $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
{ $sort: { downloadCount: -1 } }, { $limit: 10 }
```

**Query 5 — per-user storage leaderboard.** `$group` every claim by owner, join the profile, and count distinct blobs with `$size` over a `$addToSet`:

```js
{ $group: { _id: "$userId", files: { $sum: 1 },
            logicalBytes: { $sum: "$file.size" },
            uniqueHashes: { $addToSet: "$fileHash" } } },
{ $lookup: { from: "user", localField: "_id", foreignField: "_id", as: "user" } },
{ $project: { userId: { $toString: "$_id" }, name: "$user.name", files: 1,
              uniqueFiles: { $size: "$uniqueHashes" }, logicalBytes: 1 } }
```

### 4.4 Graph traversal — `$graphLookup`

The folder tree is an adjacency list. Rather than walk it in application code for analytics, `analytics.folderTree` uses **two `$graphLookup` passes**: one walks *up* the `parentId` chain to measure each folder's depth, the other walks *down* to count its descendants.

```js
// depth: walk up to the root
{ $graphLookup: { from: "folders", startWith: "$parentId",
                  connectFromField: "parentId", connectToField: "_id",
                  as: "ancestors", depthField: "depth" } },
// subtree size: walk down
{ $graphLookup: { from: "folders", startWith: "$_id",
                  connectFromField: "_id", connectToField: "parentId",
                  as: "descendants" } },
{ $project: { id: { $toString: "$_id" }, name: 1,
              parentId: { $toString: "$parentId" },
              depth: { $size: "$ancestors" },
              descendants: { $size: "$descendants" } } }
```

Rendered in the Insights page as a nested tree:

```
Personal           2 subfolders
  Documents        0 subfolders
  Photos           0 subfolders
Work               0 subfolders
```

This is the document database's answer to graph traversal: no recursive application code, one query.

---

## 5. Authentication & User Interface

### 5.1 Authentication

Basic authentication is provided by **Better Auth** on its MongoDB adapter, sharing the app's Mongoose connection. Email + password registration, scrypt-hashed passwords, and persistent sessions across requests. The four auth collections (`user`, `session`, `account`, `verification`) are owned by the adapter; the `quota` subdocument is layered onto `user` and initialized lazily on first storage access.

### 5.2 Responsive UI

A React 19 single-page app (TanStack Router + Query, Tailwind, shadcn/ui) with a collapsible sidebar. Every screen is wired to the tRPC procedures above:

- **Dashboard** — root files and folders, storage-used card, dedup counts, upload, new folder.
- **Folder view** — files and subfolders of any folder, breadcrumbs, bulk move, rename.
- **Trash** — trashed files and folders, restore, permanent delete, empty trash.
- **Shared** — public files with download counts and copyable share links.
- **Insights** — the six aggregations rendered as cards, bars, and a nested folder tree.
- **Account** — profile and avatar.
- **Public share page** — `/share/<id>`, no authentication required.

---

## 6. Intermediate Demonstration Guide

A suggested order for the demo, all runnable from the repo root.

```bash
bun run db:up        # 1. start MongoDB (podman replica set rs0)
bun run db:status    #    show container + replica set state
bun run db:seed      # 2. load 127 documents
bun run dev:server   # 3. API on :3000
```

Then, in another shell:

```bash
bun run scripts/smoke.ts            # 4. auth → quota → folder CRUD → trash → write rate limit
bun run scripts/verify-seed.ts      # 5. log in as Alice, read quota, stats, listings
bun run scripts/analytics-report.ts # 6. print all six aggregation pipelines
```

Finally, start the web app (`bun run dev:web`, or `bun run dev` for both) and walk through:

1. **Log in** as `alice@nexdrive.test / password123`.
2. **Dashboard** — files, folders, storage used, dedup counts.
3. **Insights** — the dedup report (52.2% saved), content-type breakdown, activity, folder tree, leaderboard.
4. **Upload** the same file twice — the second upload deduplicates (no re-upload, `refCount` bumps).
5. **Trash** a file and a folder, then restore one and permanently delete the other.
6. **Share** a file and open its public link in a private window.

To show the index set directly:

```bash
podman exec nexdrive-mongo mongosh nexdrive --quiet --eval 'db.getCollectionNames().sort()'
```

---

## 7. Deliverables & Rubric Coverage

| Rubric requirement | Status | Evidence |
|--------------------|--------|----------|
| Database created | ✅ | 8 collections; `bun run db:up` |
| Sample data loaded | ✅ | 127 documents; `bun run db:seed` |
| CRUD operations working | ✅ | 28 storage procedures across create/read/update/delete |
| Minimum 50 records | ✅ | 127 |
| Intermediate demonstration | ✅ | §6 runbook; three demo scripts |
| Source code repository | ✅ | github.com/Siddhj2206/NexDrive |
| **MongoDB minimums** | | |
| ≥ 5 collections | ✅ | 8 |
| 100+ sample documents | ✅ | 127 |
| CRUD operations | ✅ | §3 |
| 5 aggregation queries | ✅ | 7 (§4.3) |
| 2 indexes | ✅ | 11 (§4.1) |
| Basic authentication | ✅ | Better Auth + MongoDB adapter (§5.1) |
| Responsive UI | ✅ | React SPA, collapsible sidebar (§5.2) |

**Advanced-features mark (5):** indexing (compound, partial-unique, TTL) · multi-document transactions · aggregation pipelines (`$facet`, `$lookup`, `$group`, `$dateToString`) · graph traversal (`$graphLookup`).
