# NexDrive — Review 1

## Problem Definition, Requirement Analysis & Database Design

This document covers the problem statement, requirements, the choice of MongoDB, the collection-level data model, and a sample dataset for _NexDrive_, a self-hosted cloud storage platform with smart deduplication.

---

## 1. Problem Statement

Cloud storage services like Google Drive are closed source and charge per gigabyte. NexDrive is a **self-hosted cloud storage platform** that gives users full control over their data while adding a standout feature: **smart deduplication**. Every file is identified by a SHA-256 hash of its content, stored once, and shared across users, so if 100 users upload the same 1 GB file, it costs 1 GB, not 100 GB.

> **Problem:** Design and build NexDrive, a multi-user cloud storage web app where users upload, organize, share, trash, and permanently delete files under per-user storage quotas, while globally deduplicating identical content via content hashing and reporting real-time storage savings.

### Objectives

- Authenticated multi-user file upload, download, and in-app preview (images, video, audio, PDF, text).
- A hierarchical folder system: create, rename, move, and delete folders; move files in bulk.
- Content-addressed deduplication, so one physical blob covers one unique piece of content no matter how many users hold a copy.
- Per-user storage quotas (1 GB default) with live usage tracking and dedup-savings stats.
- Public share links with download counting.
- Trash with soft delete, restore, permanent delete, and empty-trash, for files and folders.
- Per-user API rate limiting.

### Scope

**In scope:** authentication (email/password, sessions, avatars), file and folder management, presigned-URL uploads to S3-compatible object storage, deduplication, quotas and statistics, public share links, trash, rate limiting, and a sample dataset for demonstration.

**Out of scope:** file versioning, offline sync, multi-user collaboration, team/workspace administration, billing, and sharing with specific users (public links only).

---

## 2. Requirements

### Functional

**Accounts.** Users register with name, email, and password; sessions persist across requests; avatars are optional.

**Files and folders.**

- Upload via presigned URL (max 10 GB); the server verifies the upload on completion.
- The client computes the SHA-256 hash before upload. If the hash already exists, no content is re-uploaded: a new reference is created and `refCount` is incremented.
- List files and subfolders of any folder, newest first, with trashed items hidden.
- Create, rename, move (single and bulk), and delete folders. Folders delete only when empty.
- File and folder names are validated (1–255 chars, no path traversal, no reserved system names).

**Trash.** Files and folders move to trash as a soft delete (recursive for folders), and can be restored, permanently deleted, or emptied in one action. A blob is removed from object storage only when its last reference is gone.

**Quotas and statistics.** Every upload is checked against the quota (`storageUsed + size ≤ storageLimit`). Usage tracks logical bytes: deduplicated uploads still count against the user. Statistics show total files, deduplicated files, original size, physical size, bytes saved, and savings percentage.

**Sharing.** A user can toggle public sharing on a file, generating an unguessable share ID. Anyone with the link can view metadata and download; each download is counted.

**Rate limiting.** Write requests (uploads, creates, moves, deletes, and share toggles) are limited per user per 1-second window (default 2 req/s); reads are deliberately not limited, so a dashboard that fires several queries on load cannot trip the limiter. Exceeding the limit returns 429; stale windows expire automatically.

### Non-functional

- Folder and trash listings return within roughly 200 ms at 10k assets per user.
- Operations touching multiple collections are atomic (multi-document transactions).
- Collections shard horizontally; physical storage grows with unique content, not with user count.
- File content is never public. All access goes through short-lived presigned URLs.
- Rate-limit data is ephemeral; losing it must be harmless.
- The dashboard shows live quota usage and dedup savings.
- The schema is plain TypeScript (Mongoose), with no migration ceremony.

### Assumptions

- File content lives in S3-compatible object storage; the database stores only metadata, hashes, and counters.
- MongoDB runs as a replica set (required by the transactional upload/delete flows).
- SHA-256 hashing is collision-safe for dedup identification.

---

## 3. Selection & Justification: MongoDB

### Why a document store fits this problem

Three properties of NexDrive's workload make a document database the natural fit.

**Content addressing is a lookup by key.** The heart of the system, deciding whether a given hash already exists, is a single point-read on one key for every upload. That's exactly what a document store does best, and in MongoDB it becomes a direct `_id` lookup on the `files` collection (the SHA-256 hash is the primary key).

**Heterogeneous metadata.** Assets carry optional fields: content type, share ID, folder, trash timestamp. Documents tolerate missing fields naturally, and Mongoose layers optional validation on top without schema-migration ceremony.

**High-write ephemeral data.** Rate limiting writes one document per user per second with instant expiry. MongoDB's TTL indexes delete stale windows automatically, so there's no cleanup job anywhere in the codebase.

### Why MongoDB over the other NoSQL candidates

**Neo4j** is superb for deep relationship traversal, but our folder trees are shallow and every other data shape in the app is record-like. Modeling files and assets as nodes with relationships would just be artificial bloat, and Neo4j offers no first-party integration with our authentication stack.

**Cassandra** is built for massive write throughput and horizontal scale. Our write volume is modest, and Cassandra can't do multi-collection atomicity, which the dedup ref-counting and quota flows require. Optional per-asset metadata is also awkward in a wide-column model.

**MongoDB** covers everything: files are documents keyed by content hash; TTL indexes handle rate-limit expiry natively; multi-document transactions (replica set) give the atomicity the business logic needs; native sharding covers future scale; and first-party support for the authentication stack means the user/session/account collections drop in without redesign. Of the three, only MongoDB fits all of this at once.

### Design consequences

- The 1:1 quota record embeds in the `user` document and updates atomically with `$inc`.
- The many-to-many "user ↔ file" relationship becomes link documents that own their metadata, so every per-user view (folder listing, trash listing) is a single-collection `find` with compound indexes. No joins anywhere in the app.
- Multi-document transactions keep upload/delete ref-counting atomic, so there's no torn state between the blob registry, asset links, and quota counters.
- The rest of the stack is untouched: Hono, tRPC with Zod validation, React, and R2 object storage all stay as they are.

### Trade-offs accepted

**Referential integrity is application-managed.** There are no foreign keys; every `fileHash` and `folderId` invariant is enforced inside transactions in the API layer.

**Tree traversal is application code, not a query primitive.** Trash/restore of a folder walks its subtree recursively in code. Trees are shallow in practice, and the recursion is bounded, so the cost is acceptable.

**Sum-of-distinct-sizes needs a pipeline.** The dedup-savings statistic is computed with a `$group` by `fileHash` followed by a `$sum`, which gives the same result as summing each unique size once.

---

## 4. Data Model Design

### 4.1 Entities and relationships

```
USER ──1:N──> SESSION / ACCOUNT / VERIFICATION
USER ──1:1──> QUOTA            (embedded in user)
USER ──1:N──> FOLDER ──parent(0..1)──> FOLDER   (self-referencing tree)
USER ──1:N──> ASSET
FOLDER ──1:N──> ASSET
FILE  ──1:N──> ASSET           (asset references one file by hash)
USER ──1:N──> RATE_LIMIT_WINDOW
```

- **USER**: id, name, email, emailVerified, image. Related to sessions, accounts, verifications (1:N), a quota (1:1, embedded), folders and assets (1:N).
- **FOLDER**: id, name, parentId, deletedAt (soft delete). Self-referencing: a folder has at most one parent and many children.
- **FILE**: hash (SHA-256), size, path (the object key), refCount. Many users can claim the same blob, so FILE-ASSET is many-to-many.
- **ASSET**: id, name, contentType, userId, folderId, fileHash, isPublic, publicShareId, downloadCount, deletedAt. One document per user-file claim, owning its own metadata.
- **SESSION / ACCOUNT / VERIFICATION**: standard auth records: token/expiry/ip/user-agent; provider and tokens; identifier/value/expiry.
- **QUOTA**: storageUsed, storageLimit, rateLimit. Lives inside the user document.
- **RATE_LIMIT_WINDOW**: userId, windowStart, requestCount. Ephemeral by design.

### 4.2 ER-to-Collection mapping

- **USER → `user`**: a collection; the quota is embedded (1:1, always read together).
- **QUOTA → (inside `user`)**: embedded; `$inc` updates it atomically with the user document.
- **SESSION / ACCOUNT / VERIFICATION → `user` / `session` / `account` / `verification`**: singular collection names, matching the authentication layer's convention.
- **FILE → `files`**: the SHA-256 hash is the `_id`; content addressing makes dedup detection a single point-read with no extra key or index.
- **FOLDER → `folders`**: adjacency list via `parentId`; embedding children would copy each folder down every path of the tree.
- **ASSET → `assets`**: link documents, one per user-file claim, keeping every per-user view a single-collection query.
- **RATE_LIMIT_WINDOW → `rate_limit_windows`**: its own collection with a TTL index; ephemeral data stays out of the user document.

### 4.3 Embed or reference: the rules

- **Embed the quota** in the user: 1:1, tiny, read on every request, updated atomically.
- **Reference the file from an asset** (`fileHash`): blobs are shared across users, so embedding file metadata would duplicate size and refCount and break global counting.
- **Reference the folder from an asset** (`folderId`): files move between folders and folders get trashed, and a reference survives both without copying.
- **Reference for the folder tree** (`parentId`): rename or move of a folder is a one-field update, and the tree stays shallow.
- **Keep sessions and accounts separate**: they are written far more often than users are read.
- **Keep rate-limit windows separate**: high write churn would bloat the user document; the TTL index expires it for free.

### Where the bytes actually live

A note on the boundary, because it shapes the schema: the database holds **metadata only**. File _content_ lives in a private S3-compatible bucket (Cloudflare R2), where each blob is stored under its SHA-256 hash as the object key, the same hash that is `files._id`. Uploads go straight from the browser to R2 via a short-lived **presigned PUT URL** (the server then verifies the object exists); downloads always go through a presigned GET URL that expires after an hour. The bucket itself stays private; no object is ever world-readable. Avatars follow the same pattern under an `avatars/<userId>` prefix. Deleting the last reference to a blob is the only path that removes it from R2, and that deletion happens inside the same transaction as the ref-count update.

### 4.4 Collection schemas (Mongoose)

**user** — profile with embedded quota

```ts
const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    emailVerified: { type: Boolean, default: false },
    image: String,
    quota: {
      storageUsed: { type: Number, default: 0 }, // logical bytes
      storageLimit: { type: Number, default: 1 * 1024 ** 3 }, // 1 GB
      rateLimit: { type: Number, default: 2 }, // req/sec
      updatedAt: { type: Date, default: Date.now },
    },
  },
  { timestamps: true },
);
```

> **Note:** the authentication layer operates directly on raw collections named `user`, `session`, `account`, `verification`, generates string IDs by default, and preserves extra fields such as our embedded `quota` subdocument unchanged. The quota is initialized lazily on first access, matching the upload flow.

**user / session / account / verification** — authentication collections

```ts
const SessionSchema = new Schema(
  {
    token: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    ipAddress: String,
    userAgent: String,
    userId: { type: String, required: true, index: true },
  },
  { timestamps: true },
);
// account: providerId, accountId, userId, access/refresh/id tokens, token expiries,
// scope, password (hashed)
// verification: identifier, value, expiresAt
```

**files** — the content-addressable blob registry

```ts
const FileSchema = new Schema(
  {
    _id: { type: String }, // SHA-256 hash is the primary key
    size: { type: Number, required: true },
    path: { type: String, required: true }, // object key in R2
    refCount: { type: Number, default: 1, index: true },
  },
  { timestamps: true, versionKey: false },
);

// dedup check is one lookup: files.findById(hash)
```

**folders** — adjacency-list tree

```ts
const FolderSchema = new Schema(
  {
    name: { type: String, required: true },
    userId: { type: String, required: true },
    parentId: { type: String, default: null }, // null = root
    deletedAt: { type: Date, default: null }, // trash
  },
  { timestamps: true },
);

FolderSchema.index({ userId: 1, parentId: 1, deletedAt: 1 }); // folder listing
FolderSchema.index({ userId: 1, deletedAt: 1 }); // trash listing
```

**assets** — one document per user-file claim

```ts
const AssetSchema = new Schema(
  {
    name: { type: String, required: true },
    contentType: String,
    userId: { type: String, required: true },
    folderId: { type: String, default: null },
    fileHash: { type: String, required: true },
    isPublic: { type: Boolean, default: false },
    publicShareId: { type: String, default: null },
    downloadCount: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null }, // trash
  },
  { timestamps: true },
);

AssetSchema.index({ userId: 1, folderId: 1, deletedAt: 1 }); // folder listing
AssetSchema.index({ userId: 1, deletedAt: 1, createdAt: -1 }); // trash listing
AssetSchema.index({ userId: 1, fileHash: 1 }); // dedup stats
AssetSchema.index(
  { publicShareId: 1 },
  { unique: true, partialFilterExpression: { publicShareId: { $type: "string" } } },
);
```

**rate_limit_windows** — expires itself

```ts
const RateLimitWindowSchema = new Schema(
  {
    userId: { type: String, required: true },
    windowStart: { type: Date, required: true },
    requestCount: { type: Number, default: 1 },
  },
  { timestamps: true },
);
RateLimitWindowSchema.index({ userId: 1, windowStart: 1 }, { unique: true });
RateLimitWindowSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 }); // TTL
```

> **Note — ID conventions:** MongoDB never coerces types in queries: an ObjectId and a string with the same text do not match, so one convention is held everywhere. Better Auth's MongoDB adapter generates **ObjectIds** for `user`, `session`, `account`, and `verification`, and the domain collections follow: `folders._id` and `assets._id` are ObjectIds, and the `userId` / `folderId` / `parentId` reference fields are ObjectIds too. The one deliberate exception is `files._id`, which is the SHA-256 **string** because it is the content hash by definition. The sample documents below use readable placeholders (`u_alice`, `f_personal`) for legibility; in the loaded dataset they are 24-character ObjectId hex strings.

### 4.5 The key operations in code-shaped terms

- **Upload, hash check.** `files.findById(hash)`: one point-read that decides dedup vs. new blob.
- **Upload commit (new content).** Transaction: `files.insertOne` + `assets.insertOne` + `user.$inc quota.storageUsed`.
- **Upload (dedup hit).** Transaction: `assets.insertOne` + `files.$inc refCount` + `user.$inc quota.storageUsed`.
- **List a folder.** `assets.find({ userId, folderId, deletedAt: null })` plus the same-shaped query on `folders` for subfolders.
- **List trash.** `assets.find({ userId, deletedAt: { $ne: null } })`, same for folders.
- **Share-link fetch.** `assets.findOne({ publicShareId, isPublic: true })`, then `$inc downloadCount`.
- **Delete an asset.** Transaction: `assets.deleteOne` + `files.$inc refCount` (and delete the file document plus the R2 blob when it reaches zero) + `user.$inc quota.storageUsed`.
- **Statistics.** Aggregation: `$match` the user, `$lookup` files, `$group` by hash for unique sizes, then totals for logical size, file counts, and savings.
- **Rate limiting.** `findOne({ userId, windowStart })`, then `$inc requestCount` or insert; the TTL index purges old windows.

### 4.6 Integrity

- Multi-document transactions wrap every operation that touches two or more collections (upload, dedup hit, delete, trash/restore, empty-trash), so ref-counts and quota deltas can never tear.
- Referential integrity is enforced in the API layer inside those same transactions: an asset may only reference an existing file and an owned folder, and a folder may only be moved under an owned, non-descendant folder.
- Uniqueness comes from indexes: `user.email`, `session.token`, `assets.publicShareId`, and the `(userId, windowStart)` pair on rate-limit windows.
- The quota invariant, that `storageUsed` equals the sum of the sizes of the user's assets that are not permanently deleted, is maintained by `$inc` inside transactions and independently recomputed by the statistics pipeline.

---

## 5. Sample Dataset Design

### 5.1 Scenario

Alice and Bob each have an account. Alice uploads a resume, a photo, and a video trailer; Bob uploads the _same_ trailer, a dedup hit, so his asset points at Alice's blob, plus a photo of his own. Alice organizes everything into `Personal/Photos`, makes her resume public (12 downloads so far), and has one photo sitting in her trash. The documents below cover every collection.

### 5.2 Sample documents

**user** (quota embedded)

```json
[
  {
    "_id": "u_alice",
    "name": "Alice Johnson",
    "email": "alice@example.com",
    "emailVerified": true,
    "image": null,
    "quota": {
      "storageUsed": 1085276160,
      "storageLimit": 1073741824,
      "rateLimit": 2,
      "updatedAt": "2026-08-20T10:15:00Z"
    },
    "createdAt": "2026-08-01T09:00:00Z",
    "updatedAt": "2026-08-20T10:15:00Z"
  },
  {
    "_id": "u_bob",
    "name": "Bob Kumar",
    "email": "bob@example.com",
    "emailVerified": true,
    "image": null,
    "quota": {
      "storageUsed": 1078984704,
      "storageLimit": 1073741824,
      "rateLimit": 2,
      "updatedAt": "2026-08-20T09:30:00Z"
    },
    "createdAt": "2026-08-05T14:00:00Z",
    "updatedAt": "2026-08-20T09:30:00Z"
  }
]
```

**files** (`_id` = SHA-256 hash; the trailer is shared by both users)

```json
[
  {
    "_id": "9f2c…a1b3",
    "size": 10485760,
    "path": "9f2c…a1b3",
    "refCount": 1,
    "createdAt": "2026-08-10T12:00:00Z"
  }, // resume.pdf
  {
    "_id": "d4e5…c2f8",
    "size": 1048576,
    "path": "d4e5…c2f8",
    "refCount": 1,
    "createdAt": "2026-08-12T15:30:00Z"
  }, // photo_a.jpg
  {
    "_id": "7a1b…e94d",
    "size": 1073741824,
    "path": "7a1b…e94d",
    "refCount": 2,
    "createdAt": "2026-08-15T08:00:00Z"
  }, // trailer.mp4
  {
    "_id": "3c6f…b7d2",
    "size": 5242880,
    "path": "3c6f…b7d2",
    "refCount": 1,
    "createdAt": "2026-08-18T18:45:00Z"
  } // photo_b.png
]
```

**folders**

```json
[
  {
    "_id": "f_personal",
    "name": "Personal",
    "userId": "u_alice",
    "parentId": null,
    "createdAt": "2026-08-11T10:00:00Z",
    "updatedAt": "2026-08-11T10:00:00Z",
    "deletedAt": null
  },
  {
    "_id": "f_photos",
    "name": "Photos",
    "userId": "u_alice",
    "parentId": "f_personal",
    "createdAt": "2026-08-12T15:00:00Z",
    "updatedAt": "2026-08-12T15:00:00Z",
    "deletedAt": null
  },
  {
    "_id": "f_work",
    "name": "Work",
    "userId": "u_bob",
    "parentId": null,
    "createdAt": "2026-08-06T09:00:00Z",
    "updatedAt": "2026-08-06T09:00:00Z",
    "deletedAt": null
  }
]
```

**assets**

```json
[
  {
    "_id": "a_1",
    "name": "resume.pdf",
    "contentType": "application/pdf",
    "userId": "u_alice",
    "folderId": "f_personal",
    "fileHash": "9f2c…a1b3",
    "isPublic": true,
    "publicShareId": "6b8e1f2a-9c4d-4e5f-8a7b-2c3d4e5f6a7b",
    "downloadCount": 12,
    "deletedAt": null,
    "createdAt": "2026-08-10T12:00:00Z",
    "updatedAt": "2026-08-20T10:00:00Z"
  },
  {
    "_id": "a_2",
    "name": "photo_a.jpg",
    "contentType": "image/jpeg",
    "userId": "u_alice",
    "folderId": "f_photos",
    "fileHash": "d4e5…c2f8",
    "isPublic": false,
    "publicShareId": null,
    "downloadCount": 0,
    "deletedAt": "2026-08-19T09:00:00Z",
    "createdAt": "2026-08-12T15:30:00Z",
    "updatedAt": "2026-08-19T09:00:00Z"
  },
  {
    "_id": "a_3",
    "name": "trailer.mp4",
    "contentType": "video/mp4",
    "userId": "u_alice",
    "folderId": "f_personal",
    "fileHash": "7a1b…e94d",
    "isPublic": false,
    "publicShareId": null,
    "downloadCount": 0,
    "deletedAt": null,
    "createdAt": "2026-08-15T08:00:00Z",
    "updatedAt": "2026-08-15T08:00:00Z"
  },
  {
    "_id": "a_4",
    "name": "trailer.mp4",
    "contentType": "video/mp4",
    "userId": "u_bob",
    "folderId": "f_work",
    "fileHash": "7a1b…e94d",
    "isPublic": false,
    "publicShareId": null,
    "downloadCount": 0,
    "deletedAt": null,
    "createdAt": "2026-08-16T11:00:00Z",
    "updatedAt": "2026-08-16T11:00:00Z"
  },
  {
    "_id": "a_5",
    "name": "photo_b.png",
    "contentType": "image/png",
    "userId": "u_bob",
    "folderId": null,
    "fileHash": "3c6f…b7d2",
    "isPublic": false,
    "publicShareId": null,
    "downloadCount": 0,
    "deletedAt": null,
    "createdAt": "2026-08-18T18:45:00Z",
    "updatedAt": "2026-08-18T18:45:00Z"
  }
]
```

**user / session / account / verification** (condensed)

```json
// session (collection: session)
{ "_id": "s_1", "token": "tok_alice_1", "expiresAt": "2026-09-01T09:00:00Z",
  "ipAddress": "192.168.1.10", "userAgent": "Mozilla/5.0", "userId": "u_alice",
  "createdAt": "2026-08-20T09:00:00Z", "updatedAt": "2026-08-20T09:00:00Z" }
// account (collection: account)
{ "_id": "acc_1", "providerId": "credential", "accountId": "u_alice", "userId": "u_alice",
  "password": "$2b$10$…hashed…", "createdAt": "2026-08-01T09:00:00Z", "updatedAt": "2026-08-01T09:00:00Z" }
// verification (collection: verification)
{ "_id": "v_1", "identifier": "alice@example.com", "value": "8f3a…token…",
  "expiresAt": "2026-08-01T10:00:00Z", "createdAt": "2026-08-01T09:00:00Z", "updatedAt": "2026-08-01T09:00:00Z" }
```

**rate_limit_windows** (TTL-expired after 60 s)

```json
[
  { "_id": "rl_1", "userId": "u_alice", "windowStart": "2026-08-20T10:15:06Z", "requestCount": 2 },
  { "_id": "rl_2", "userId": "u_bob", "windowStart": "2026-08-20T09:30:04Z", "requestCount": 1 }
]
```

### 5.3 Sanity checks on the sample

- **Dedup:** four blobs, five assets. Alice's and Bob's trailers share one 1 GB blob (`refCount: 2`).
- **Quotas:** Alice's 1,085,276,160 B breaks down as resume (10 MB) + trailer (1 GB) + trashed photo (1 MB); Bob's 1,078,984,704 B as trailer (1 GB) + photo_b (5 MB).
- **Trash:** `a_2.deletedAt` is set, so the photo appears in Alice's trash and is restorable.
- **Sharing:** `a_1` resolves through `publicShareId`; every public fetch increments its `downloadCount`.
- **Rate limiting:** `rl_1` shows Alice at her 2 req/s ceiling; one more write inside that window gets a 429.

> **Note — seeded quotas:** the platform default quota is 1 GB (the `storageLimit` above), but the *loaded demo dataset* gives each seeded user a 5 GB limit so the full sample set — which includes a 1 GB trailer and a 1.5 GB archive — fits under quota. New accounts still start at 1 GB.
