# NexDrive

A self-hosted cloud storage platform with smart, content-addressed deduplication. Built on MongoDB, with a React front end and a Hono + tRPC API.

Every file is identified by the SHA-256 hash of its content, stored once, and shared across users. If 100 users upload the same 1 GB file, it costs 1 GB — not 100 GB.

> **BCSE302P — Database Systems Lab project.** Review 1 (problem definition, requirement analysis, database design) is in [`docs/review-1.md`](docs/review-1.md).

## Features

- **Content-addressed deduplication** — a blob is stored once and referenced by any number of users; `refCount` tracks the claims.
- **Hierarchical folders** — create, rename, move (single and bulk), and delete; recursive trash and restore.
- **Trash** — soft delete for files and folders, restore, permanent delete, and empty-trash. A blob leaves object storage only when its last reference is gone.
- **Storage quotas** — per-user logical byte accounting, embedded in the user document and updated atomically with `$inc`.
- **Deduplication statistics** — an aggregation pipeline reports logical vs physical size and savings.
- **Public share links** — unguessable share IDs with download counting.
- **Per-user rate limiting** — one document per second window, expired automatically by a TTL index.
- **In-app preview** — images, video, audio, PDF, and text.
- **Profile avatars.**

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Bun](https://bun.sh) |
| Frontend | React 19, [TanStack Router](https://tanstack.com/router), [TanStack Query](https://tanstack.com/query) |
| Styling | TailwindCSS, [shadcn/ui](https://ui.shadcn.com) |
| Backend | [Hono](https://hono.dev) |
| API | [tRPC](https://trpc.io) (end-to-end type safety) |
| Database | **MongoDB**, [Mongoose](https://mongoosejs.com) |
| Auth | [Better Auth](https://better-auth.com) (MongoDB adapter) |
| Storage | Cloudflare R2 (S3-compatible) |
| Monorepo | [Turborepo](https://turbo.build) |

## Project Structure

```
NexDrive/
├── apps/
│   ├── web/                 # Frontend (React + TanStack Router)
│   └── server/              # Backend API (Hono + tRPC)
├── packages/
│   ├── api/                 # tRPC routers & business logic
│   │   └── src/routers/
│   │       └── storage/     # File/folder operations
│   ├── auth/                # Better Auth configuration (MongoDB adapter)
│   ├── db/                  # MongoDB connection, Mongoose models, seed
│   │   └── src/
│   │       ├── connection.ts
│   │       ├── models/      # user, file, folder, asset, rate-limit-window
│   │       ├── quota.ts
│   │       ├── indexes.ts
│   │       └── seed.ts
│   └── config/              # Shared TypeScript config
├── scripts/
│   ├── mongo.sh             # podman-managed MongoDB replica set
│   ├── smoke.ts             # API smoke test (no object storage needed)
│   └── verify-seed.ts       # logs in as the demo user and reads stats
└── docs/
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.3.5+
- [podman](https://podman.io) (for the local MongoDB replica set)
- A Cloudflare R2 bucket (or any S3-compatible storage)

### 1. Install dependencies

```bash
bun install
```

### 2. Start MongoDB

A **single-node replica set** named `rs0`, managed by podman. The replica set is required for multi-document transactions — the dedup ref-counting and quota flows depend on them.

```bash
bun run db:up        # create + start the container, initiate the replica set
bun run db:status    # show container and replica set state
bun run db:down      # stop and remove the container (volume kept)
bun run db:reset     # down, wipe the volume, up again
```

Connection string: `mongodb://localhost:27017/nexdrive?replicaSet=rs0`

### 3. Configure environment

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

**Server environment (`apps/server/.env`):**

```env
# Database
MONGODB_URI="mongodb://localhost:27017/nexdrive?replicaSet=rs0"

# Authentication
BETTER_AUTH_SECRET=your-secret-key-min-32-chars
BETTER_AUTH_URL=http://localhost:3000

# CORS
CORS_ORIGIN=http://localhost:3001

# Cloudflare R2 Storage
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=nexdrive
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

**Web environment (`apps/web/.env`):**

```env
VITE_SERVER_URL=http://localhost:3000
```

### 4. Load the sample dataset

```bash
bun run db:seed
```

This clears the collections and loads 100+ documents: 6 users, their credential accounts, nested folders, 30 unique blobs, 57 asset claims (many deduplicated), trashed items, and public shares.

Demo login: **`alice@nexdrive.test` / `password123`** (all seeded users share this password).

### 5. Run

```bash
bun run dev
```

- Web app: http://localhost:3001
- API server: http://localhost:3000

## Available Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start all apps in development mode |
| `bun run build` | Build all apps for production |
| `bun run dev:web` | Start only the web frontend |
| `bun run dev:server` | Start only the API server |
| `bun run check-types` | TypeScript type checking across every package |
| `bun run db:up` / `db:down` / `db:status` / `db:reset` | Manage the MongoDB container |
| `bun run db:seed` | Load the sample dataset |
| `bun run scripts/smoke.ts` | API smoke test (auth, folders, trash, stats) |
| `bun run scripts/verify-seed.ts` | Sign in as the demo user and read stats |
| `bun run scripts/analytics-report.ts` | Print every analytics aggregation |

## Database Design

### Collections

| Collection | Purpose | Notes |
|------------|---------|-------|
| `user` | Profile with embedded `quota` | Owned by Better Auth; quota updated with `$inc` |
| `session`, `account`, `verification` | Auth records | Managed by Better Auth's MongoDB adapter |
| `files` | Content-addressable blob registry | `_id` **is** the SHA-256 hash |
| `folders` | Adjacency-list folder tree | `parentId` reference, `deletedAt` for trash |
| `assets` | One document per user-file claim | Owns name, folder, sharing, trash state |
| `rate_limit_windows` | Ephemeral rate-limit counters | Self-expiring via a TTL index |

### Deduplication

1. The client computes the SHA-256 hash before upload.
2. The server does one point-read: `File.findById(hash)`.
3. If the hash exists, no content is re-uploaded — a new `asset` is created and `files.refCount` is incremented.
4. If not, the content is uploaded to R2 and a new `files` document is created.

Upload commit, dedup hit, delete, trash/restore, and empty-trash all run inside **multi-document transactions**, so ref-counts and quota deltas never tear.

### Indexes

Beyond the default `_id` indexes:

- `files.refCount`
- `folders`: `{userId, parentId, deletedAt}`, `{userId, deletedAt}`, `{parentId}`
- `assets`: `{userId, folderId, deletedAt}`, `{userId, deletedAt, createdAt}`, `{userId, fileHash}`, and a **partial unique** index on `publicShareId`
- `rate_limit_windows`: unique `{userId, windowStart}` and a **TTL** index on `createdAt` (60 s)

## Cloudflare R2 Setup

1. Go to Cloudflare Dashboard > R2.
2. Create a new bucket (e.g., `nexdrive`).
3. **Manage R2 API Tokens** > Create API Token with **Object Read & Write**.
4. Copy the Access Key ID and Secret Access Key.
5. Endpoint: `https://<account-id>.r2.cloudflarestorage.com`.

The bucket stays private. Uploads go directly from the browser via short-lived presigned `PUT` URLs; downloads use presigned `GET` URLs.

## API Routes

All routes live in `packages/api/src/routers/storage/storage.ts`.

| Procedure | Description |
|-----------|-------------|
| `storage.getUploadPresignedUrl` | Presigned URL for upload, with dedup check |
| `storage.confirmUpload` | Confirm upload and create the asset |
| `storage.listFiles` | List files and subfolders |
| `storage.getFile` | File details with a download URL |
| `storage.deleteAsset` | Delete an asset (ref-counted) |
| `storage.moveToTrash` / `restoreFromTrash` | Soft delete and restore |
| `storage.permanentlyDelete` | Permanent deletion |
| `storage.createFolder` / `renameFolder` / `moveFolder` / `deleteFolder` | Folder management |
| `storage.togglePublic` | Toggle a public share link |
| `storage.getPublicFile` | Access a shared file (no auth) |
| `storage.getStats` / `getQuota` | Storage statistics and quota |
| `storage.getAvatarUploadUrl` / `getAvatarUrl` | Profile avatars |

### Analytics (`packages/api/src/routers/analytics/analytics.ts`)

Read-only aggregation pipelines behind the Insights view:

| Procedure | Pipeline highlights |
|-----------|---------------------|
| `analytics.dedupReport` | `$facet` — system-wide logical vs physical bytes, saved %, dedup ratio, most-duplicated blobs |
| `analytics.storageByType` | `$lookup` + `$group` by content type for the current user |
| `analytics.uploadActivity` | `$group` over `$dateToString` — files and bytes per day |
| `analytics.topShared` | Two `$lookup`s + `$sort` — most-downloaded public files |
| `analytics.folderTree` | Two `$graphLookup`s — folder depth and subtree size |
| `analytics.topUsers` | `$group` + `$lookup` — storage leaderboard with distinct-blob counts |

---

Built with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack).
