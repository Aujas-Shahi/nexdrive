/**
 * NexDrive procedure coverage test.
 *
 * Exercises the storage procedures the smoke test does not: file rename and
 * move, folder move (single, bulk, and the circular-reference guard), the
 * empty-only `deleteFolder` guard, file-level trash and restore, permanent
 * delete of a file and of a folder tree, `deleteAsset`, public sharing, and
 * `getFile`.
 *
 * It needs no object storage. A fresh user acquires files through the dedup
 * path: it "uploads" content whose hash the seed already registered, so the
 * server creates a reference without issuing an upload. Seeded blobs keep a
 * refCount above zero after this user releases them, so no R2 delete fires.
 *
 * Start the server and seed the database first (`bun run db:seed`,
 * `bun run dev:server`), then run this from the repo root:
 * `bun run scripts/procedures.ts`
 */
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { AppRouter } from "@nexdrive/api/routers/index";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const PACE_MS = 600;
const KB = 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Space out rate-limited calls so the 2 req/s cap is not tripped. */
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  await sleep(PACE_MS);
  return fn();
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/** Expect `fn` to fail with the given tRPC error code. */
async function expectError(
  fn: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof TRPCClientError && error.data?.code === code) return;
    throw new Error(`Assertion failed: ${message} (got ${error})`);
  }
  throw new Error(`Assertion failed: ${message} (call succeeded)`);
}

/** The seed labels each blob and stores it under the SHA-256 of that label. */
const seededHash = (label: string) =>
  new Bun.CryptoHasher("sha256").update(label).digest("hex");

// Small seeded blobs this user will claim through the dedup path.
const SEEDED = [
  { label: "notes.txt", size: 12 * KB, type: "text/plain" },
  { label: "icon.png", size: 20 * KB, type: "image/png" },
  { label: "readme.md", size: 6 * KB, type: "text/markdown" },
  { label: "logo.svg", size: 45 * KB, type: "image/svg+xml" },
];

async function createUser(): Promise<string[]> {
  const email = `procedures-${Date.now()}@nexdrive.test`;
  const res = await fetch(`${SERVER_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "password123",
      name: "Procedure Test",
    }),
  });
  if (!res.ok) {
    throw new Error(`Signup failed: ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie();
  assert(cookies.length > 0, "signup should return a session cookie");
  console.log(`  ✓ signed up ${email}`);
  return cookies;
}

function clientWith(cookies: string[]) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${SERVER_URL}/trpc`,
        headers: { Cookie: cookies.join("; ") },
      }),
    ],
  });
}

async function main(): Promise<void> {
  console.log("\n=== NexDrive procedure coverage test ===\n");

  const client = clientWith(await createUser());
  const anonymous = clientWith([]);

  // --- Acquire files through the dedup path --------------------------------

  for (const blob of SEEDED) {
    const result = await paced(() =>
      client.storage.getUploadPresignedUrl.mutate({
        filename: blob.label,
        size: blob.size,
        hash: seededHash(blob.label),
        contentType: blob.type,
      }),
    );
    assert(
      result.deduplicated,
      `${blob.label} should dedup against the seed (run \`bun run db:seed\` first)`,
    );
  }
  const totalSize = SEEDED.reduce((sum, blob) => sum + blob.size, 0);
  const quota = await client.storage.getQuota.query();
  assert(quota.storageUsed === totalSize, "quota counts deduplicated bytes");
  console.log(`  ✓ claimed ${SEEDED.length} seeded files via dedup (no upload)`);

  const root = await client.storage.listFiles.query();
  const fileId = (label: string) => {
    const file = root.files.find((f) => f.name === label);
    assert(file, `${label} is listed at the root`);
    return file!.id;
  };
  const notes = fileId("notes.txt");
  const icon = fileId("icon.png");
  const readme = fileId("readme.md");
  const logo = fileId("logo.svg");
  assert(
    root.files.every((f) => f.isDeduplicated),
    "claimed files are marked deduplicated",
  );

  // --- getFile ---------------------------------------------------------------

  const details = await client.storage.getFile.query({ id: notes });
  assert(details.size === 12 * KB, "getFile returns the blob size");
  assert(details.refCount > 1, "getFile reports the shared refCount");
  assert(details.downloadUrl.includes("X-Amz-Signature"), "getFile presigns");
  console.log(`  ✓ getFile (refCount ${details.refCount}, presigned URL)`);

  // --- renameFile ------------------------------------------------------------

  const renamed = await paced(() =>
    client.storage.renameFile.mutate({ id: notes, name: "meeting-notes.txt" }),
  );
  assert(renamed.asset.name === "meeting-notes.txt", "file renamed");
  console.log("  ✓ renameFile");

  // --- Folders for the move tests -------------------------------------------

  const createFolder = async (name: string, parentId?: string) => {
    const result = await paced(() =>
      client.storage.createFolder.mutate({ name, parentId }),
    );
    return result.folder.id;
  };
  const docs = await createFolder("Docs");
  const media = await createFolder("Media");
  const archive = await createFolder("Archive", docs);

  // --- moveFile / moveFiles ---------------------------------------------------

  await paced(() =>
    client.storage.moveFile.mutate({ id: notes, folderId: docs }),
  );
  let inDocs = await client.storage.listFiles.query({ folderId: docs });
  assert(
    inDocs.files.some((f) => f.id === notes),
    "moved file appears in target folder",
  );
  console.log("  ✓ moveFile");

  const bulk = await paced(() =>
    client.storage.moveFiles.mutate({ ids: [icon, logo], folderId: media }),
  );
  assert(bulk.movedCount === 2, "moveFiles moved both files");
  const inMedia = await client.storage.listFiles.query({ folderId: media });
  assert(inMedia.files.length === 2, "both files are in Media");
  console.log("  ✓ moveFiles (2 files)");

  // --- moveFolder and the circular-reference guard ---------------------------

  await paced(() =>
    client.storage.moveFolder.mutate({ id: media, parentId: docs }),
  );
  inDocs = await client.storage.listFiles.query({ folderId: docs });
  assert(
    inDocs.folders.some((f) => f.id === media),
    "Media is now inside Docs",
  );
  console.log("  ✓ moveFolder");

  await paced(() =>
    expectError(
      () => client.storage.moveFolder.mutate({ id: docs, parentId: archive }),
      "BAD_REQUEST",
      "moving a folder into its own descendant is rejected",
    ),
  );
  await paced(() =>
    expectError(
      () => client.storage.moveFolder.mutate({ id: docs, parentId: docs }),
      "BAD_REQUEST",
      "moving a folder into itself is rejected",
    ),
  );
  console.log("  ✓ moveFolder rejects circular moves (BAD_REQUEST)");

  const bulkFolders = await paced(() =>
    client.storage.moveFolders.mutate({ ids: [media, docs], parentId: archive }),
  );
  assert(
    bulkFolders.movedCount === 1,
    "moveFolders moves Media but skips Docs (Archive is inside Docs)",
  );
  await paced(() =>
    client.storage.moveFolders.mutate({ ids: [media], parentId: null }),
  );
  const rootFolders = await client.storage.listFiles.query();
  assert(
    rootFolders.folders.some((f) => f.id === media),
    "Media moved back to the root",
  );
  console.log("  ✓ moveFolders (skips the circular move)");

  // --- deleteFolder: empty-only guard ----------------------------------------

  await paced(() =>
    expectError(
      () => client.storage.deleteFolder.mutate({ id: docs }),
      "PRECONDITION_FAILED",
      "deleting a non-empty folder is rejected",
    ),
  );
  await paced(() => client.storage.deleteFolder.mutate({ id: archive }));
  inDocs = await client.storage.listFiles.query({ folderId: docs });
  assert(
    !inDocs.folders.some((f) => f.id === archive),
    "empty folder deleted",
  );
  console.log("  ✓ deleteFolder (empty only; non-empty → PRECONDITION_FAILED)");

  // --- Public sharing ---------------------------------------------------------

  const shared = await paced(() =>
    client.storage.togglePublic.mutate({ id: readme, isPublic: true }),
  );
  const shareId = shared.shareUrl?.split("/").pop();
  assert(shared.isPublic && shareId, "togglePublic returns a share URL");

  const publicFile = await anonymous.storage.getPublicFile.query({
    shareId: shareId!,
  });
  assert(publicFile.name === "readme.md", "share link resolves without login");
  assert(publicFile.downloadCount === 1, "share download is counted");

  await paced(() =>
    client.storage.togglePublic.mutate({ id: readme, isPublic: false }),
  );
  await expectError(
    () => anonymous.storage.getPublicFile.query({ shareId: shareId! }),
    "NOT_FOUND",
    "unshared link no longer resolves",
  );
  console.log("  ✓ togglePublic + getPublicFile (anonymous, counted, revocable)");

  // --- File-level trash and restore ------------------------------------------

  await paced(() => client.storage.moveToTrash.mutate({ id: readme }));
  let trash = await client.storage.listTrash.query();
  assert(trash.files.some((f) => f.id === readme), "file appears in trash");
  const afterTrash = await client.storage.listFiles.query();
  assert(
    !afterTrash.files.some((f) => f.id === readme),
    "trashed file is hidden from its folder",
  );

  await paced(() => client.storage.restoreFromTrash.mutate({ id: readme }));
  const afterRestore = await client.storage.listFiles.query();
  assert(
    afterRestore.files.some((f) => f.id === readme),
    "restored file is back in its folder",
  );
  console.log("  ✓ moveToTrash + restoreFromTrash (file)");

  // --- permanentlyDelete (single file) ---------------------------------------

  await paced(() => client.storage.moveToTrash.mutate({ id: readme }));
  await paced(() => client.storage.permanentlyDelete.mutate({ id: readme }));
  trash = await client.storage.listTrash.query();
  assert(!trash.files.some((f) => f.id === readme), "file gone from trash");
  let used = (await client.storage.getQuota.query()).storageUsed;
  assert(used === totalSize - 6 * KB, "permanent delete frees its bytes");
  console.log("  ✓ permanentlyDelete (file, quota released)");

  // --- permanentlyDeleteFolder (recursive) -----------------------------------

  // Docs now holds meeting-notes.txt; Media (at the root) holds icon + logo.
  await paced(() => client.storage.moveFolder.mutate({ id: media, parentId: docs }));
  await paced(() => client.storage.moveFolderToTrash.mutate({ id: docs }));
  const purged = await paced(() =>
    client.storage.permanentlyDeleteFolder.mutate({ id: docs }),
  );
  assert(purged.deletedFolders === 2, "Docs and Media deleted");
  assert(purged.deletedFiles === 3, "all three files inside deleted");
  assert(
    purged.freedBytes === 12 * KB + 20 * KB + 45 * KB,
    "freed bytes match the deleted files",
  );
  used = (await client.storage.getQuota.query()).storageUsed;
  assert(used === 0, "quota is back to zero");
  console.log(
    `  ✓ permanentlyDeleteFolder (${purged.deletedFolders} folders, ${purged.deletedFiles} files, ${purged.freedBytesFormatted})`,
  );

  // --- deleteAsset ------------------------------------------------------------

  const again = await paced(() =>
    client.storage.getUploadPresignedUrl.mutate({
      filename: "notes.txt",
      size: 12 * KB,
      hash: seededHash("notes.txt"),
      contentType: "text/plain",
    }),
  );
  assert(again.deduplicated, "re-claim dedups again");
  const [reclaimed] = (await client.storage.listFiles.query()).files;
  assert(reclaimed, "re-claimed file is listed");
  await paced(() => client.storage.deleteAsset.mutate({ id: reclaimed!.id }));
  const final = await client.storage.listFiles.query();
  assert(final.files.length === 0, "deleteAsset removed the file");
  used = (await client.storage.getQuota.query()).storageUsed;
  assert(used === 0, "deleteAsset released its bytes");
  console.log("  ✓ deleteAsset");

  console.log("\n=== procedure coverage test passed ===\n");
}

main().catch((err) => {
  console.error("\n✗ procedure coverage test failed:", err.message ?? err);
  process.exit(1);
});
