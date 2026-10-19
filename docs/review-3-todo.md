# NexDrive — Review 3: Core Project TODO

Final review (10 marks). This file tracks the **core project** only — the system itself.
Presentation slides, the final report, the user manual, and the demo video are excluded
by request.

Last updated: 2026-10-15 · HEAD `a273c25`

---

## Status at a glance

| Area | State |
|------|-------|
| MongoDB data layer (8 collections, schemas, refs) | ✅ Done |
| Indexes (11: compound, partial-unique, TTL) | ✅ Done |
| CRUD — 28 storage procedures | ✅ Done |
| Multi-document transactions (8 operations) | ✅ Done |
| Aggregations — 7 pipelines incl. `$graphLookup` | ✅ Done |
| Authentication (Better Auth + MongoDB adapter) | ✅ Done |
| Responsive UI (all screens) | ✅ Done |
| Sample dataset (127 documents) | ✅ Done |
| Typecheck / build | ✅ 5/5 packages, 2/2 builds |
| Object storage (R2) — upload/dedup/download path | ✅ `scripts/r2.ts` |
| Procedure test coverage | ✅ `scripts/procedures.ts` |
| MongoDB `$jsonSchema` document validation | ✅ `files`, `folders`, `assets` |

---

## 1. R2 object-storage integration — BLOCKER

Everything that touches actual file bytes is **written but never executed**. Until this
runs, the product's core feature is unverified.

### Procedures that must be exercised

| Procedure | Unverified behaviour |
|-----------|----------------------|
| `storage.getUploadPresignedUrl` | presigned PUT URL for new content |
| `storage.confirmUpload` | `s3.exists()` verification, blob upsert, `refCount` init |
| dedup hit | same bytes → same hash → new asset + `refCount` bump, no re-upload |
| `storage.getFile` | presigned GET for download/preview |
| `storage.getPublicFile` | presigned GET for a public share |
| `storage.getAvatarUploadUrl` / `getAvatarUrl` | avatar PUT + presigned GET |

### Steps (owner action)

1. Cloudflare → R2 → create bucket `nexdrive` (private).
2. R2 → API → create token, **Object Read & Write**, scoped to the bucket.
3. Bucket → Settings → **CORS policy** allowing `http://localhost:3001` with
   methods `GET, PUT, HEAD`. *(Browser uploads go directly to R2 — CORS is required.)*
4. Fill `apps/server/.env`:
   ```env
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET_NAME=nexdrive
   R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   ```
   Leave `R2_PUBLIC_URL` unset (bucket is private).
5. Restart the API server.
6. Verify (server running):
   ```bash
   bun run test-backend.ts
   ```
   This signs up a user, uploads to R2, confirms dedup on a second upload, shares the
   file, and hard-deletes it — the full path.

### Acceptance criteria

- [x] Upload a real file → it appears in the dashboard and previews/downloads.
- [x] Upload the same file again → `deduplicated: true`, no second PUT, `refCount` = 2.
- [x] Storage-used increases on both uploads (logical quota) but physical storage does not.
- [x] Delete both references → the R2 object is removed (blob garbage-collected).
- [x] Public share link downloads the file without authentication.
- [x] Avatar upload and display work (API; check the UI by hand).

---

## 2. Procedure test coverage

These are implemented and R2-independent, but no test has run them. Extend the test
scripts to cover them against the seeded dataset (Alice).

### Untested procedures

- [x] `renameFile`
- [x] `moveFile`, `moveFiles`
- [x] `moveFolder`, `moveFolders`
- [x] `moveFolder` circular-reference guard (moving a folder into its own descendant → `BAD_REQUEST`)
- [x] file-level `moveToTrash` + `restoreFromTrash`
- [x] `permanentlyDelete` (single file)
- [x] `permanentlyDeleteFolder` (recursive, frees bytes)
- [x] `deleteFolder` (empty-only guard: non-empty folder → `PRECONDITION_FAILED`)
- [x] `togglePublic` + `getPublicFile` (no R2 needed — `getPublicFile` only presigns)
- [x] `getFile` (presigns; object need not exist)

### Acceptance criteria

- [x] A single script (`scripts/procedures.ts`) exercises every procedure above and asserts the expected result,
      including the two error guards (circular move, non-empty delete).
- [x] `bun run scripts/smoke.ts` stays green.

---

## 3. Optional — MongoDB `$jsonSchema` document validation

We validate at the Mongoose layer only. MongoDB collection validators are a listed
MongoDB deliverable.

- [x] Add `$jsonSchema` validators for `files`, `folders`, `assets` (required fields,
      types, enums where sensible).
- [x] Apply them in a script (or the seed) so the demo can show a rejected malformed
      insert.

---

## 4. Accepted edge cases (no action, documented)

- A `confirmUpload` that never arrives leaves an orphaned R2 object — no cleanup job.
- The quota check runs at presign time, not at confirm, so concurrent uploads can
  slightly overshoot the limit.

---

## Verification commands

```bash
bun install
bun run check-types                       # 5/5 packages
bun run build                             # web + server
bun run db:up                             # podman replica set rs0
bun run db:seed                           # 127 documents + $jsonSchema validators
bun run db:validation-demo                # malformed inserts rejected by MongoDB
bun run dev:server                        # API on :3000

# in another shell
bun run scripts/smoke.ts                  # auth, quota, folder CRUD, trash, write rate limit
bun run scripts/procedures.ts             # rename, move, circular guard, share, trash, hard delete
bun run scripts/verify-seed.ts            # log in as Alice, read quota/stats/listings
bun run scripts/analytics-report.ts       # all 6 aggregation pipelines
bun run scripts/r2.ts                     # full upload/dedup/download/share/GC path (needs R2)
```

> MongoDB is **not currently running** — start it with `bun run db:up` before any demo.

---

## Definition of done for the core (Review 3)

- [x] R2 configured; `scripts/r2.ts` passes end to end.
- [x] All procedures in §2 exercised and green.
- [x] (Optional) `$jsonSchema` validators applied.
- [ ] Full manual walkthrough: log in → upload → dedup → preview → share → trash →
      restore → hard-delete, with the Insights page showing live savings.
