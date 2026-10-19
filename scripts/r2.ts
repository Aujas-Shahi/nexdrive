/**
 * NexDrive object-storage (R2) end-to-end test.
 *
 * Proves the byte path the other tests skip: presigned upload, confirm, dedup
 * on a second upload, presigned download, public share download, blob garbage
 * collection when the last reference goes, and avatar upload.
 *
 * Each run uploads fresh random content, so it never collides with earlier
 * runs. The script reads the R2 credentials from `apps/server/.env` only to
 * check, independently of the API, whether the object exists in the bucket.
 *
 * Start the server first (`bun run dev:server`), then run this from the repo
 * root: `bun run scripts/r2.ts`
 */
import { fileURLToPath } from "node:url";
import { S3Client } from "bun";
import dotenv from "dotenv";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@nexdrive/api/routers/index";

dotenv.config({
  path: fileURLToPath(new URL("../apps/server/.env", import.meta.url)),
  quiet: true,
});

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const PACE_MS = 600;

const s3 = new S3Client({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET_NAME,
  endpoint: process.env.R2_ENDPOINT,
  region: "auto",
});

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

async function createUser(): Promise<string[]> {
  const email = `r2-${Date.now()}@nexdrive.test`;
  const res = await fetch(`${SERVER_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name: "R2 Test" }),
  });
  if (!res.ok) {
    throw new Error(`Signup failed: ${res.status} ${await res.text()}`);
  }
  console.log(`  ✓ signed up ${email}`);
  return res.headers.getSetCookie();
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
  console.log("\n=== NexDrive R2 end-to-end test ===\n");

  const client = clientWith(await createUser());
  const anonymous = clientWith([]);

  const content = `NexDrive R2 test ${crypto.randomUUID()}\n`;
  const bytes = new TextEncoder().encode(content);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const upload = {
    filename: "r2-test.txt",
    size: bytes.length,
    hash,
    contentType: "text/plain",
  };

  // --- First upload: presign → PUT → confirm --------------------------------

  const presigned = await paced(() =>
    client.storage.getUploadPresignedUrl.mutate(upload),
  );
  assert(!presigned.deduplicated && presigned.url, "new content gets a PUT URL");

  const put = await fetch(presigned.url!, { method: "PUT", body: bytes });
  assert(put.ok, `PUT to R2 succeeds (got ${put.status} ${await put.text()})`);
  assert(await s3.file(hash).exists(), "object is in the bucket");

  await paced(() => client.storage.confirmUpload.mutate(upload));
  let used = (await client.storage.getQuota.query()).storageUsed;
  assert(used === bytes.length, "quota counts the upload");
  console.log(`  ✓ uploaded to R2 and confirmed (${bytes.length} bytes)`);

  // --- Download through a presigned GET -------------------------------------

  const [original] = (await client.storage.listFiles.query()).files;
  assert(original?.name === "r2-test.txt", "uploaded file is listed");
  const details = await client.storage.getFile.query({ id: original!.id });
  const download = await fetch(details.downloadUrl);
  assert(download.ok, `presigned GET succeeds (got ${download.status})`);
  assert((await download.text()) === content, "downloaded bytes match");
  console.log("  ✓ downloaded via presigned URL, bytes match");

  // --- Second upload of the same bytes: dedup, no PUT -----------------------

  const second = await paced(() =>
    client.storage.getUploadPresignedUrl.mutate({
      ...upload,
      filename: "r2-test-copy.txt",
    }),
  );
  assert(second.deduplicated && !second.url, "same bytes dedup without a PUT");
  const files = (await client.storage.listFiles.query()).files;
  assert(files.length === 2, "both references are listed");
  assert(files.every((f) => f.refCount === 2), "blob refCount is 2");
  used = (await client.storage.getQuota.query()).storageUsed;
  assert(used === 2 * bytes.length, "logical quota counts both references");
  const stats = await client.storage.getStats.query();
  assert(
    stats.actualStorageUsed === bytes.length,
    "physical storage counts the blob once",
  );
  console.log("  ✓ second upload deduplicated (refCount 2, stored once)");

  // --- Public share: anonymous download -------------------------------------

  const shared = await paced(() =>
    client.storage.togglePublic.mutate({ id: original!.id, isPublic: true }),
  );
  const shareId = shared.shareUrl!.split("/").pop()!;
  const publicFile = await anonymous.storage.getPublicFile.query({ shareId });
  const publicDownload = await fetch(publicFile.downloadUrl);
  assert(
    publicDownload.ok && (await publicDownload.text()) === content,
    "share link downloads the file without logging in",
  );
  console.log("  ✓ public share link downloads without login");

  // --- Garbage collection: blob leaves R2 with its last reference -----------

  const copy = files.find((f) => f.name === "r2-test-copy.txt")!;
  await paced(() => client.storage.deleteAsset.mutate({ id: copy.id }));
  assert(await s3.file(hash).exists(), "blob survives while one reference remains");
  console.log("  ✓ first delete keeps the blob (still referenced)");

  await paced(() => client.storage.deleteAsset.mutate({ id: original!.id }));
  assert(!(await s3.file(hash).exists()), "blob is removed from R2");
  used = (await client.storage.getQuota.query()).storageUsed;
  assert(used === 0, "quota is back to zero");
  console.log("  ✓ last delete removes the blob from R2");

  // --- Avatar upload + presigned view ---------------------------------------

  // A 1×1 transparent PNG.
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  const avatar = await paced(() =>
    client.storage.getAvatarUploadUrl.mutate({ contentType: "image/png" }),
  );
  const avatarPut = await fetch(avatar.url, {
    method: "PUT",
    body: png,
    headers: { "Content-Type": "image/png" },
  });
  assert(avatarPut.ok, `avatar PUT succeeds (got ${avatarPut.status})`);
  const { avatarUrl } = await client.storage.getAvatarUrl.query();
  assert(avatarUrl, "avatar URL is returned once uploaded");
  const avatarGet = await fetch(avatarUrl!);
  assert(avatarGet.ok, "avatar downloads");
  await s3.file(avatar.key).delete();
  console.log("  ✓ avatar upload + view");

  console.log("\n=== R2 end-to-end test passed ===\n");
}

main().catch((err) => {
  console.error("\n✗ R2 test failed:", err.message ?? err);
  process.exit(1);
});
