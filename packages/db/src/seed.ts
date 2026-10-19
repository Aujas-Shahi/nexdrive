/**
 * NexDrive sample dataset.
 *
 * Loads a reproducible dataset that covers every collection and every feature
 * the Review 2 demo touches: content-addressed deduplication (shared blobs with
 * refCount > 1), nested folders, trashed files and folders, public shares with
 * download counts, per-user quotas, and ephemeral rate-limit windows.
 *
 * All demo users share the password `password123`. Passwords are hashed with
 * the same scrypt parameters Better Auth uses, so the seeded accounts can log
 * in for real.
 *
 * Run from the repo root:  bun run db:seed
 */
import { randomUUID } from "node:crypto";
import { scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Types } from "mongoose";
import { connectDB, getDb } from "./connection";
import { DEFAULT_RATE_LIMIT } from "./constants";
import { ensureIndexes } from "./indexes";

// Load the server env if MONGODB_URI isn't already in the environment.
dotenv.config({ path: fileURLToPath(new URL("../../../apps/server/.env", import.meta.url)) });

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const DEMO_PASSWORD = "password123";
const DEMO_STORAGE_LIMIT = 5 * GB; // headroom so the sample data fits under quota

const BASE_TIME = new Date("2026-08-01T09:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

/** Deterministic timestamp helper: `day` days after the base date. */
const at = (day: number, hour = 9) =>
  new Date(BASE_TIME + day * DAY + hour * 60 * 60 * 1000);

/** A realistic-looking SHA-256 hash for a labelled blob. */
const hashOf = (label: string) =>
  new Bun.CryptoHasher("sha256").update(label).digest("hex");

/**
 * Reproduce Better Auth's password hash: scrypt over the NFKC-normalized
 * password with a 16-byte hex salt, encoded as `salt:key`.
 */
function hashPassword(password: string): string {
  const salt = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "utf8"), 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  }).toString("hex");
  return `${salt}:${key}`;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const USERS = [
  { key: "alice", name: "Alice Johnson", email: "alice@nexdrive.test" },
  { key: "bob", name: "Bob Kumar", email: "bob@nexdrive.test" },
  { key: "carol", name: "Carol Diaz", email: "carol@nexdrive.test" },
  { key: "david", name: "David Chen", email: "david@nexdrive.test" },
  { key: "emma", name: "Emma Wilson", email: "emma@nexdrive.test" },
  { key: "frank", name: "Frank Osei", email: "frank@nexdrive.test" },
] as const;

type UserKey = (typeof USERS)[number]["key"];

// ---------------------------------------------------------------------------
// Blobs (unique content) — the content-addressed `files` collection
// ---------------------------------------------------------------------------

const BLOBS = {
  resume: { label: "resume.pdf", size: 10 * MB, type: "application/pdf" },
  photoA: { label: "photo_a.jpg", size: 1 * MB, type: "image/jpeg" },
  trailer: { label: "trailer.mp4", size: 1 * GB, type: "video/mp4" },
  photoB: { label: "photo_b.png", size: 5 * MB, type: "image/png" },
  reportQ3: { label: "report_q3.pdf", size: 2.5 * MB, type: "application/pdf" },
  budget: { label: "budget.xlsx", size: 800 * 1024, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  notes: { label: "notes.txt", size: 12 * 1024, type: "text/plain" },
  logo: { label: "logo.svg", size: 45 * 1024, type: "image/svg+xml" },
  banner: { label: "banner.png", size: 3 * MB, type: "image/png" },
  podcast: { label: "podcast.mp3", size: 60 * MB, type: "audio/mpeg" },
  song1: { label: "song_one.mp3", size: 8 * MB, type: "audio/mpeg" },
  song2: { label: "song_two.mp3", size: 9 * MB, type: "audio/mpeg" },
  dataset: { label: "dataset.csv", size: 120 * MB, type: "text/csv" },
  backup: { label: "backup.zip", size: 500 * MB, type: "application/zip" },
  slides: { label: "slides.pptx", size: 15 * MB, type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  invoice: { label: "invoice.pdf", size: 300 * 1024, type: "application/pdf" },
  contract: { label: "contract.docx", size: 2 * MB, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  wallpaper: { label: "wallpaper.jpg", size: 4 * MB, type: "image/jpeg" },
  tutorial: { label: "tutorial.mp4", size: 250 * MB, type: "video/mp4" },
  archive: { label: "archive.zip", size: 1536 * MB, type: "application/zip" },
  icon: { label: "icon.png", size: 20 * 1024, type: "image/png" },
  readme: { label: "readme.md", size: 6 * 1024, type: "text/markdown" },
  chart: { label: "chart.png", size: 700 * 1024, type: "image/png" },
  demo: { label: "demo.mp4", size: 300 * MB, type: "video/mp4" },
  manual: { label: "manual.pdf", size: 8 * MB, type: "application/pdf" },
  avatar: { label: "avatar.png", size: 150 * 1024, type: "image/png" },
  spreadsheet: { label: "spreadsheet.xlsx", size: 1.2 * MB, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  transcript: { label: "transcript.txt", size: 90 * 1024, type: "text/plain" },
  render: { label: "render.png", size: 12 * MB, type: "image/png" },
  voice: { label: "voice_memo.wav", size: 45 * MB, type: "audio/wav" },
} as const;

type BlobKey = keyof typeof BLOBS;

// ---------------------------------------------------------------------------
// Folder trees per user: key -> { name, parent }
// ---------------------------------------------------------------------------

const FOLDERS: Record<UserKey, { key: string; name: string; parent: string | null }[]> = {
  alice: [
    { key: "personal", name: "Personal", parent: null },
    { key: "photos", name: "Photos", parent: "personal" },
    { key: "documents", name: "Documents", parent: "personal" },
    { key: "work", name: "Work", parent: null },
  ],
  bob: [
    { key: "work", name: "Work", parent: null },
    { key: "projects", name: "Projects", parent: "work" },
    { key: "reports", name: "Reports", parent: "work" },
    { key: "media", name: "Media", parent: null },
  ],
  carol: [
    { key: "backup", name: "Backup", parent: null },
    { key: "backup2025", name: "2025", parent: "backup" },
    { key: "backup2026", name: "2026", parent: "backup" },
  ],
  david: [
    { key: "music", name: "Music", parent: null },
    { key: "albums", name: "Albums", parent: "music" },
    { key: "singles", name: "Singles", parent: "music" },
  ],
  emma: [
    { key: "design", name: "Design", parent: null },
    { key: "logos", name: "Logos", parent: "design" },
    { key: "mockups", name: "Mockups", parent: "design" },
    { key: "exports", name: "Exports", parent: "design" },
  ],
  frank: [
    { key: "archive", name: "Archive", parent: null },
    { key: "old", name: "Old", parent: "archive" },
  ],
};

// ---------------------------------------------------------------------------
// Assets: (user, blob, folderKey | null, display name, options)
// ---------------------------------------------------------------------------

type AssetSpec = {
  user: UserKey;
  blob: BlobKey;
  folder: string | null;
  name?: string;
  trashed?: boolean;
  shared?: boolean;
  downloads?: number;
  day: number;
};

const ASSETS: AssetSpec[] = [
  // Alice — the Review 1 scenario
  { user: "alice", blob: "resume", folder: "personal", shared: true, downloads: 12, day: 9 },
  { user: "alice", blob: "photoA", folder: "photos", trashed: true, day: 11 },
  { user: "alice", blob: "trailer", folder: "personal", day: 14 },
  { user: "alice", blob: "reportQ3", folder: "documents", day: 15 },
  { user: "alice", blob: "budget", folder: "documents", day: 16 },
  { user: "alice", blob: "banner", folder: "personal", day: 17 },
  { user: "alice", blob: "slides", folder: "work", day: 18 },
  { user: "alice", blob: "invoice", folder: "work", day: 19 },
  { user: "alice", blob: "contract", folder: "personal", day: 20 },
  { user: "alice", blob: "notes", folder: null, day: 21 },

  // Bob
  { user: "bob", blob: "trailer", folder: "work", day: 15 }, // dedup hit vs Alice
  { user: "bob", blob: "photoB", folder: null, day: 17 },
  { user: "bob", blob: "reportQ3", folder: "reports", day: 16 }, // dedup hit vs Alice
  { user: "bob", blob: "dataset", folder: "projects", day: 18 },
  { user: "bob", blob: "backup", folder: "work", day: 19 },
  { user: "bob", blob: "readme", folder: null, day: 20 },
  { user: "bob", blob: "chart", folder: "reports", day: 21 },
  { user: "bob", blob: "tutorial", folder: "media", day: 22 },
  { user: "bob", blob: "song1", folder: "media", shared: true, downloads: 5, day: 23 },
  { user: "bob", blob: "voice", folder: null, trashed: true, day: 24 },

  // Carol
  { user: "carol", blob: "backup", folder: "backup2025", day: 10 },
  { user: "carol", blob: "archive", folder: "backup2025", day: 11 },
  { user: "carol", blob: "dataset", folder: "backup2026", day: 12 },
  { user: "carol", blob: "spreadsheet", folder: "backup2026", day: 13 },
  { user: "carol", blob: "transcript", folder: null, day: 14 },
  { user: "carol", blob: "render", folder: null, day: 15 },
  { user: "carol", blob: "demo", folder: "backup2025", shared: true, downloads: 3, day: 16 },
  { user: "carol", blob: "manual", folder: null, day: 17 },
  { user: "carol", blob: "voice", folder: "backup2026", day: 18 },

  // David
  { user: "david", blob: "song1", folder: "albums", day: 8 },
  { user: "david", blob: "song2", folder: "albums", day: 9 },
  { user: "david", blob: "podcast", folder: "albums", day: 10 },
  { user: "david", blob: "voice", folder: "singles", day: 11 },
  { user: "david", blob: "logo", folder: null, day: 12 },
  { user: "david", blob: "icon", folder: null, day: 13 },
  { user: "david", blob: "wallpaper", folder: null, day: 14 },
  { user: "david", blob: "banner", folder: "singles", day: 15 },
  { user: "david", blob: "notes", folder: null, day: 16 },

  // Emma
  { user: "emma", blob: "logo", folder: "logos", day: 6 },
  { user: "emma", blob: "icon", folder: "logos", day: 7 },
  { user: "emma", blob: "banner", folder: "mockups", day: 8 },
  { user: "emma", blob: "render", folder: "exports", day: 9 },
  { user: "emma", blob: "wallpaper", folder: "mockups", day: 10 },
  { user: "emma", blob: "chart", folder: "exports", day: 11 },
  { user: "emma", blob: "avatar", folder: "logos", day: 12 },
  { user: "emma", blob: "slides", folder: "exports", day: 13 },
  { user: "emma", blob: "readme", folder: "mockups", day: 14 },
  { user: "emma", blob: "manual", folder: "exports", trashed: true, day: 15 },

  // Frank
  { user: "frank", blob: "archive", folder: "old", day: 5 },
  { user: "frank", blob: "backup", folder: "old", day: 6 },
  { user: "frank", blob: "dataset", folder: null, day: 7 },
  { user: "frank", blob: "podcast", folder: null, day: 8 },
  { user: "frank", blob: "tutorial", folder: null, day: 9 },
  { user: "frank", blob: "transcript", folder: "archive", day: 10 },
  { user: "frank", blob: "notes", folder: null, day: 11 },
  { user: "frank", blob: "song2", folder: null, day: 12 },
  { user: "frank", blob: "photoB", folder: null, trashed: true, day: 13 },
];

// ---------------------------------------------------------------------------
// Build + insert
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Copy apps/server/.env.example to .env or export it.",
    );
  }
  await connectDB(uri);
  const db = getDb();

  const collections = [
    "user",
    "session",
    "account",
    "verification",
    "files",
    "folders",
    "assets",
    "rate_limit_windows",
  ];
  console.log("clearing existing data…");
  for (const name of collections) {
    await db.collection(name).deleteMany({});
  }

  // Build the index set (compound, partial-unique, TTL) up front so the demo
  // can show it exists without waiting on lazy index creation.
  await ensureIndexes();

  // --- users + credential accounts -----------------------------------------
  const userIds = new Map<UserKey, Types.ObjectId>();
  const userDocs: Record<string, unknown>[] = [];
  const accountDocs: Record<string, unknown>[] = [];

  for (const user of USERS) {
    const id = new Types.ObjectId();
    userIds.set(user.key, id);
    userDocs.push({
      _id: id,
      name: user.name,
      email: user.email,
      emailVerified: true,
      image: null,
      quota: {
        storageUsed: 0, // filled in once assets are known
        storageLimit: DEMO_STORAGE_LIMIT,
        rateLimit: DEFAULT_RATE_LIMIT,
        updatedAt: at(30, 12),
      },
      createdAt: at(0),
      updatedAt: at(30, 12),
    });
    accountDocs.push({
      _id: new Types.ObjectId(),
      accountId: id.toHexString(),
      providerId: "credential",
      userId: id,
      password: hashPassword(DEMO_PASSWORD),
      createdAt: at(0),
      updatedAt: at(0),
    });
  }

  // --- folders --------------------------------------------------------------
  const folderIds = new Map<string, Types.ObjectId>();
  const folderDocs: Record<string, unknown>[] = [];

  for (const user of USERS) {
    for (const folder of FOLDERS[user.key]) {
      const id = new Types.ObjectId();
      folderIds.set(`${user.key}:${folder.key}`, id);
      folderDocs.push({
        _id: id,
        name: folder.name,
        userId: userIds.get(user.key),
        parentId: folder.parent
          ? folderIds.get(`${user.key}:${folder.parent}`)
          : null,
        deletedAt: null,
        createdAt: at(1, folder.name.length),
        updatedAt: at(1, folder.name.length),
      });
    }
  }

  // Carol's Backup/2025 folder is in the trash, along with its contents.
  const carolBackup2025 = folderIds.get("carol:backup2025")!;
  for (const doc of folderDocs) {
    if (doc._id === carolBackup2025) doc.deletedAt = at(25);
  }

  // --- blobs ----------------------------------------------------------------
  const fileDocs = ASSETS.reduce<Record<string, unknown>[]>((docs, spec) => {
    const blob = BLOBS[spec.blob];
    const hash = hashOf(blob.label);
    if (!docs.some((d) => d._id === hash)) {
      docs.push({
        _id: hash,
        size: blob.size,
        path: hash,
        refCount: 0, // filled in below
        createdAt: at(spec.day),
        updatedAt: at(spec.day),
      });
    }
    return docs;
  }, []);
  const fileByHash = new Map(fileDocs.map((doc) => [doc._id as string, doc]));

  // --- assets ---------------------------------------------------------------
  const assetDocs: Record<string, unknown>[] = [];
  const usedBytes = new Map<UserKey, number>();
  const usedHashes = new Map<UserKey, Set<string>>();

  for (const spec of ASSETS) {
    const blob = BLOBS[spec.blob];
    const hash = hashOf(blob.label);
    const trashed = spec.trashed ?? false;
    assetDocs.push({
      _id: new Types.ObjectId(),
      name: spec.name ?? blob.label,
      contentType: blob.type,
      userId: userIds.get(spec.user),
      folderId: spec.folder
        ? folderIds.get(`${spec.user}:${spec.folder}`)
        : null,
      fileHash: hash,
      isPublic: spec.shared ?? false,
      publicShareId: spec.shared ? randomUUID() : null,
      downloadCount: spec.downloads ?? 0,
      deletedAt: trashed ? at(25) : null,
      createdAt: at(spec.day),
      updatedAt: at(spec.day, 10),
    });

    // Blob refCount counts every claim, trashed or not.
    const fileDoc = fileByHash.get(hash)!;
    fileDoc.refCount = (fileDoc.refCount as number) + 1;

    // Quota tracks logical bytes: deduplicated uploads still count.
    usedBytes.set(spec.user, (usedBytes.get(spec.user) ?? 0) + blob.size);
    if (!usedHashes.has(spec.user)) usedHashes.set(spec.user, new Set());
    usedHashes.get(spec.user)!.add(hash);
  }

  // Assets sitting in Carol's trashed folder are trashed too.
  for (const doc of assetDocs) {
    if (doc.folderId === carolBackup2025) doc.deletedAt = at(25);
  }

  // --- fill quotas ----------------------------------------------------------
  for (const user of USERS) {
    const id = userIds.get(user.key);
    const doc = userDocs.find((u) => u._id === id)!;
    (doc.quota as { storageUsed: number }).storageUsed =
      usedBytes.get(user.key) ?? 0;
  }

  // --- rate-limit windows (ephemeral; the TTL index will reap these) --------
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / 1000) * 1000);
  const rateDocs = USERS.slice(0, 4).map((user) => ({
    _id: new Types.ObjectId(),
    userId: userIds.get(user.key),
    windowStart,
    requestCount: 1,
    createdAt: new Date(now),
  }));

  // --- sessions + verifications (auth collections, for completeness) --------
  const sessionDocs = USERS.slice(0, 2).map((user) => ({
    _id: new Types.ObjectId(),
    token: randomUUID().replace(/-/g, ""),
    expiresAt: at(40, 9),
    ipAddress: "192.168.1.10",
    userAgent: "Mozilla/5.0",
    userId: userIds.get(user.key),
    createdAt: at(30, 9),
    updatedAt: at(30, 9),
  }));

  const verificationDocs = USERS.slice(0, 2).map((user) => ({
    _id: new Types.ObjectId(),
    identifier: user.email,
    value: randomUUID(),
    expiresAt: at(2, 10),
    createdAt: at(0, 9),
    updatedAt: at(0, 9),
  }));

  // --- insert ---------------------------------------------------------------
  await db.collection("user").insertMany(userDocs);
  await db.collection("account").insertMany(accountDocs);
  await db.collection("session").insertMany(sessionDocs);
  await db.collection("verification").insertMany(verificationDocs);
  await db.collection("folders").insertMany(folderDocs);
  await db.collection("files").insertMany(fileDocs);
  await db.collection("assets").insertMany(assetDocs);
  await db.collection("rate_limit_windows").insertMany(rateDocs);

  // --- report ---------------------------------------------------------------
  const uniqueBlobs = fileDocs.length;
  const logicalBytes = assetDocs.reduce(
    (sum, asset) =>
      sum + (fileByHash.get(asset.fileHash as string)!.size as number),
    0,
  );
  const physicalBytes = fileDocs.reduce(
    (sum, file) => sum + (file.size as number),
    0,
  );

  console.log("\nseeded NexDrive sample data:");
  console.log(`  users        ${userDocs.length}`);
  console.log(`  accounts     ${accountDocs.length}`);
  console.log(`  sessions     ${sessionDocs.length}`);
  console.log(`  verifications ${verificationDocs.length}`);
  console.log(`  folders      ${folderDocs.length}`);
  console.log(`  files        ${fileDocs.length} unique blobs`);
  console.log(`  assets       ${assetDocs.length} claims`);
  console.log(`  rate windows ${rateDocs.length}`);
  const totalDocs =
    userDocs.length +
    accountDocs.length +
    sessionDocs.length +
    verificationDocs.length +
    folderDocs.length +
    fileDocs.length +
    assetDocs.length +
    rateDocs.length;
  console.log(`  total        ${totalDocs} documents`);
  console.log(
    `\n  dedup: ${assetDocs.length} claims over ${uniqueBlobs} blobs — ` +
      `${(logicalBytes / MB).toFixed(1)} MB logical vs ${(physicalBytes / MB).toFixed(1)} MB physical`,
  );
  console.log(`\n  demo login: alice@nexdrive.test / ${DEMO_PASSWORD}\n`);

  process.exit(0);
}

seed().catch((error) => {
  console.error("seed failed:", error);
  process.exit(1);
});
