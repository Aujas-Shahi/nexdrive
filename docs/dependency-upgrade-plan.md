# NexDrive — Major Dependency Upgrade Plan

Status: **proposed** · Scope: the major-version bumps deliberately held back during the
first dependency pass.

> **Scope note.** This plan covers *only* the version bumps. The Drizzle→MongoDB port,
> the NexDrive rename, the analytics router, and the Insights page were separate work
> that already existed when this plan was written — they are not "scope creep" of the
> upgrade, and the plan's baseline is the post-port, pre-upgrade tree.

Every package below is currently installed at a version whose **major** is behind
`latest`. Minor/patch updates are already applied. This plan moves the majors in
four phases, each independently verifiable and revertible.

## Target matrix

| Package | Current | Target | Where | Blast radius |
|---|---|---|---|---|
| `mongoose` | 8.24.4 | 9.10.2 | `packages/db` | **Data layer** — every query |
| `mongodb` | 6.20.0 | 7.6.0 | `packages/db`, `packages/auth` | Driver + Better Auth adapter |
| `vite` | 7.3.6 | 8.3.0 | `apps/web` | Frontend build/dev |
| `@vitejs/plugin-react` | 5.2.0 | 6.1.1 | `apps/web` | React transform |
| `vite-tsconfig-paths` | 5.1.4 | 6.1.1 | `apps/web` | `@/*` path resolution |
| `typescript` | 5.9.3 | 7.0.2 | catalog | **Whole repo** — typecheck |
| `lucide-react` | 0.562.0 | 1.47.0 | `apps/web` | Icons |
| `jsdom` | 26.1.0 | 30.1.1 | `apps/web` (dev) | Test env only |
| `web-vitals` | 5.3.0 | 6.2.2 | `apps/web` (dev) | Perf reporting |
| `tsdown` | 0.16.8 | 0.23.0 | `apps/server` (dev) | Server build only |
| `dotenv` | 17.4.2 | 18.0.3 | catalog | Env loading |

## Compatibility findings (verified against the npm registry)

These constraints drove the phase grouping:

- **`mongoose@9` requires `mongodb@~7.6`** — the two must move together.
- **`better-auth@1.7.5` (already installed) accepts `mongodb@^6 || ^7`** — so the
  auth adapter is compatible with the driver bump. No auth change needed.
- **`@vitejs/plugin-react@6` requires `vite@^8`** — they must move together.
- **`@tanstack/react-start@1.168` accepts `vite >=7`**, and
  **`@tanstack/router-plugin@1.168` accepts `vite >=5 … >=8`** — no change needed.
- **`@tailwindcss/vite@4.3.3` accepts `vite ^5 || ^6 || ^7 || ^8`** — fine.
- **`lucide-react@1.x` only removes brand icons** and defaults `aria-hidden`. We
  import no brand icons, so this is effectively drop-in.
- **Node engines**: local Node is **v26.9.0**, which satisfies `vite@8`
  (`^20.19 || >=22.12`), `tsdown@0.23` (`>=26`), `@tanstack/react-start`
  (`>=22.12`), and `jsdom@30` (`>=26`). *Other machines/CI must be on Node 22.12+
  (24.15+ or 26+ for jsdom/tsdown).*
- **`typescript@7.0.2`** is the native compiler (platform binaries), and `tsdown`
  lists it as a supported peer. This is the least predictable bump.

## Phase A — Data layer (`mongoose` 9 + `mongodb` 7)

**Status: DONE.** Resolved to a single `mongoose@9.10.2` + `mongodb@7.6.0`
(Better Auth's adapter accepts `^6 || ^7`, so no auth change). Two Mongoose 9
breaking changes surfaced and were fixed:

1. **Aggregation-pipeline updates need opt-in.** `adjustStorageUsed` clamps the
   quota with a pipeline array; Mongoose 9 rejects that unless
   `{ updatePipeline: true }` is passed. Fixed in `packages/db/src/quota.ts`.
2. **`{ new: true }` is deprecated** on `findOneAndUpdate` — replaced with
   `{ returnDocument: "after" }` across `storage.ts` (12 sites).

Gate passed: `check-types`, `db:seed`, index dump (TTL + partial-unique intact),
`smoke`, `verify-seed`, `analytics-report`, and no Mongoose warnings in the
server log.

The highest-value, most mechanical phase. Isolated to `packages/db` and `packages/auth`.

**Changes**
- Catalog: `mongodb` `~6.20.0` → `^7.6.0`; `mongoose` `^8.24.4` → `^9.10.2`.
- `packages/db/src/connection.ts` imports `Db` / `MongoClient` types from
  `mongodb`; re-verify they still line up with Better Auth's adapter signature
  (both now resolve to the same 7.6 copy).

**Watch for (Mongoose 9 breaking changes)**
- Deprecated query/update options removed; `strictQuery` behaviour.
- `Document.toObject()` / `toJSON` virtual handling (we rely on the `id` virtual).
- `updateMany`/`findOneAndUpdate` result field names (`matchedCount`,
  `modifiedCount`) — used in `moveFiles`, `deleteAsset`, trash flows.
- `session.withTransaction` and `createIndexes` on typed models.
- TTL and partial-unique index definitions (unchanged syntax, but re-verify).

**Gate**: `check-types` · `db:seed` · `scripts/smoke.ts` · `verify-seed.ts` ·
`analytics-report.ts` · `mongosh` index dump (TTL + partial-unique still present).

**Rollback**: restore catalog versions + `bun.lock`; no code changes expected.

## Phase B — Frontend build (`vite` 8 + plugin-react 6 + paths 6)

**Status: DONE.** `vite@8.3.0` (Rolldown), `@vitejs/plugin-react@6.1.1`,
`vite-tsconfig-paths@6.1.1`, `jsdom@30`, `web-vitals@6`. No code changes were
needed for the build itself.

Gate passed: `check-types`, `bun run build` (Rolldown, 644 ms), `vite dev` boots,
and — via the browser — `/dashboard` and `/dashboard/insights` render live data
with zero console errors.

Findings:
- Vite 8 prints a notice that tsconfig paths are now resolved natively
  (`resolve.tsconfigPaths: true`), so `vite-tsconfig-paths` could be dropped in a
  later cleanup. Left in place for now.
- Browser verification caught an unrelated robustness bug: `storage.getAvatarUrl`
  threw a 500 when R2 was unreachable, which took down the whole dashboard via
  the layout's `beforeLoad` prefetch. It now degrades to `{ avatarUrl: null }`.
- Insights polish: friendly MIME labels (PPTX/DOCX/XLSX instead of the raw
  subtype) and a properly nested `$graphLookup` folder tree.

**Changes**
- `apps/web`: `vite` `^7` → `^8`, `@vitejs/plugin-react` `^5` → `^6`,
  `vite-tsconfig-paths` `^5` → `^6`.
- `web-vitals` `^5` → `^6` and `jsdom` `^26` → `^30` ride along (dev-only).

**Watch for**
- Vite 8 is **Rolldown-based**; custom Rollup options would need
  `rolldownOptions`. `apps/web/vite.config.ts` is currently default, so likely
  unaffected.
- TanStack Start plugin + Tailwind v4 plugin ordering under Rolldown.
- `@vitejs/plugin-react@6` peer includes optional `oxc-transform-react` /
  `@rolldown/plugin-babel` — only needed if we add a Babel plugin (we don't).
- `vite-tsconfig-paths@6` API is compatible; verify `@/*` still resolves.

**Gate**: `bun run build` (web) · `vite dev` boots · `routeTree.gen.ts`
regenerates · load `/dashboard` and `/dashboard/insights` in the browser.

**Rollback**: revert `apps/web/package.json` + `bun.lock`.

## Phase C — TypeScript 7 (isolated, highest risk)

**Status: DONE.** `typescript@7.0.2` across all packages. The only breakage was a
config change: **TS 7 removed `baseUrl`** (`error TS5102`), so it was deleted from
`apps/web/tsconfig.json` and `apps/server/tsconfig.json`. `paths` already resolve
relative to the tsconfig, so `@/*` kept working. `tsc -b` with `composite` project
references works on the native compiler.

Gate passed: `check-types` (all 5 packages), `tsdown` server build, `vite` web
build, and the three runtime scripts.

Attempt only after A and B are green.

**Changes**
- Catalog `typescript` `^5` → `^7.0.2`; bump `@types/bun` if it complains.
- `tsdown` (server build) is compatible with TS 7 as a peer, so Phase D can stay
  separate.

**Watch for**
- `tsc -b` with `composite` project references and `declaration`/`declarationMap`
  — confirm the native compiler supports our build mode.
- `noUnusedLocals` / `noUnusedParameters`, `verbatimModuleSyntax`,
  `moduleResolution: bundler`, `noUncheckedIndexedAccess` — our strict base
  config relies on all of these.
- Any `@types/*` package that hasn't caught up.

**Fallback if it fails**: keep TypeScript 5.9 (the rest of the upgrade is
independent), or switch `check-types` to per-package `tsc --noEmit` if `tsc -b`
is the only gap. Document whichever we land on.

**Gate**: `bun run check-types` across all five packages, then the full runtime
gate below.

## Phase D — Remaining majors (low risk, one commit)

**Status: DONE.** `dotenv@18.0.3`, `lucide-react@1.47.0`, `tsdown@0.23.0`
(`jsdom@30` and `web-vitals@6` shipped with Phase B). No code changes needed.

Gate passed: `check-types`, `vite` web build, `tsdown` server build, `db:seed`
(dotenv 18 loads `apps/server/.env` correctly), the three runtime scripts, and a
browser render of the Insights page (Lucide 1.x icons intact, no console errors).

- `dotenv` 17 → 18 — verify `import "dotenv/config"` and `dotenv.config({ path })`
  still load `apps/server/.env` (seed and server).
- `lucide-react` 0.562 → 1.47 — audit every icon import (no brand icons used).
- `tsdown` 0.16 → 0.23 — rebuild `apps/server` (`bun run build` in the workspace).
- `jsdom` 30, `web-vitals` 6 — dev-only; no test suite currently consumes them.

**Gate**: typecheck · server `tsdown` build · web build · all three scripts.

## Post-review fixes (applied after the code review)

- **Rate limiting is now write-only.** Mutations are limited; reads (`listFiles`,
  `getFile`, `listTrash`, `getStats`, `getQuota`) are not, so the dashboard's
  three-call load can no longer trip its own limiter. The limiter no longer rolls
  back with a second, racy `$inc` — a rejected request simply consumes its slot.
  `scripts/smoke.ts` and `test-backend.ts` now demonstrate the limiter with a
  burst of `createFolder` writes.
- **De-duplicated the storage router.** Four near-identical teardown blocks now
  share one `releaseAsset(session, asset, blobSize)`; the three recursive folder
  walks share one `collectSubtree(userId, rootId, filter)`; the duplicated
  `isDescendant` collapsed to one module-level helper. `MAX_FILE_SIZE` is now
  imported from `@nexdrive/db` instead of re-declared.
- **Removed dead code.** `objectid.ts` dropped `isValidObjectId` /
  `toObjectIdOrNull`; the router's local `hex` helper now uses the shared
  `idString`. `isConnected` and the inert `jsonWithId` / `toJSON` machinery are
  gone (every read uses `.lean()` plus an explicit serializer). `ensureIndexes`
  is now actually used — the seed calls it.
- **`moveFiles`** reports `modifiedCount`, not `matchedCount`, so a no-op move
  isn't counted.
- **`renameFile`** returns a `serializeAsset` shape like every other endpoint.
- **Analytics privacy.** `analytics.topUsers` no longer projects user emails.
- **Seed covers every collection.** Added session and verification documents —
  127 documents total.
- **Docs.** `review-1.md` now says `partialFilterExpression` (not the invalid
  `partialIndexExpression`), documents the write-only rate limit, and notes the
  seeded users' 5 GB quota.

Deliberately **not** changed: `getStats` still counts trashed assets. That is
consistent with quota accounting (logical bytes include trashed items) and with
the Review 1 sample, where Alice's quota includes her trashed photo.

Still open: the plan's "one phase per commit" rule was not followed — all work
remains in a single uncommitted tree.

## Follow-ups found during the upgrade (not part of the version bumps)

- **`vite-tsconfig-paths` is now redundant.** Vite 8 resolves tsconfig paths
  natively via `resolve.tsconfigPaths`. Can be dropped in a cleanup.
- **`getAvatarUrl` hardening** (fixed in Phase B): object-storage errors now
  degrade to `{ avatarUrl: null }` instead of 500-ing the dashboard.

## Global verification gate (after every phase)

```bash
bun install
bun run check-types
bun run build
bun run db:up && bun run db:seed
bun run dev:server      # then, in another shell:
bun run scripts/smoke.ts
bun run scripts/verify-seed.ts
bun run scripts/analytics-report.ts
bun run dev:web         # then load /dashboard and /dashboard/insights
```

## Execution rules

1. **One phase per commit.** Never mix A and C.
2. **Revert on red.** `git checkout -- package.json bun.lock <workspace>/package.json`
   restores the previous resolution.
3. **No code changes pre-emptively.** Make a phase's code changes only when the
   gate actually fails, so the upgrade stays honest.
4. **Record outcomes** in this file as each phase lands (done / reverted / notes).

## Risk summary

| Phase | Likelihood of breakage | Impact if broken | Isolation |
|---|---|---|---|
| A — mongoose/mongodb | Medium | High (data layer) | `packages/db`, `packages/auth` |
| B — vite 8 | Medium | Medium (frontend build) | `apps/web` |
| C — TypeScript 7 | High | Medium (typecheck only) | whole repo, easily reverted |
| D — misc majors | Low | Low | per-package |
