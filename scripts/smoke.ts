/**
 * NexDrive database smoke test.
 *
 * Exercises the MongoDB-backed API end to end without touching object storage,
 * so it runs offline: auth, embedded quota, folder CRUD, recursive trash, and
 * the aggregation-backed statistics endpoint.
 *
 * Requests are paced because mutations are rate-limited to 2 req/s per user
 * (reads are not limited).
 *
 * Start the server first (`bun run dev:server`), then run this from the repo
 * root: `bun run scripts/smoke.ts`
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@nexdrive/api/routers/index";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const PACE_MS = 600;

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
  const email = `smoke-${Date.now()}@nexdrive.test`;
  const res = await fetch(`${SERVER_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "password123",
      name: "Smoke Test",
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
  console.log("\n=== NexDrive DB smoke test ===\n");

  const cookies = await createUser();
  const client = clientWith(cookies);

  const health = await client.healthCheck.query();
  assert(health === "OK", "health check returns OK");
  console.log("  ✓ health check");

  // Embedded quota is created lazily on first storage access.
  const quota = await paced(() => client.storage.getQuota.query());
  assert(quota.storageUsed === 0, "new user starts with 0 bytes used");
  assert(quota.storageLimit === 1024 ** 3, "default limit is 1 GB");
  console.log(`  ✓ lazy quota created (limit ${quota.storageLimitFormatted})`);

  // Folder CRUD.
  const root = await paced(() =>
    client.storage.createFolder.mutate({ name: "Personal" }),
  );
  const rootId = root.folder?.id;
  assert(rootId && /^[a-f0-9]{24}$/.test(rootId), "folder id is an ObjectId");
  console.log(`  ✓ created folder ${root.folder?.name} (${rootId})`);

  const child = await paced(() =>
    client.storage.createFolder.mutate({
      name: "Photos",
      parentId: rootId,
    }),
  );
  const childId = child.folder?.id;
  assert(childId, "child folder created");

  const renamed = await paced(() =>
    client.storage.renameFolder.mutate({
      id: childId!,
      name: "Pictures",
    }),
  );
  assert(renamed.folder?.name === "Pictures", "folder renamed");
  console.log("  ✓ nested folder created + renamed");

  const listing = await paced(() =>
    client.storage.listFiles.query({ folderId: rootId }),
  );
  assert(
    listing.folders.some((f) => f.id === childId),
    "child appears under parent",
  );
  console.log("  ✓ folder listing finds the child");

  // Rate limiting applies to mutations (reads are free). Fire a burst of writes
  // and expect the limiter to reject at least one.
  let rateLimitHit = false;
  try {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        client.storage.createFolder.mutate({
          name: `burst-${i}`,
          parentId: rootId,
        }),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Rate limit")) rateLimitHit = true;
  }
  assert(rateLimitHit, "a burst of writes should hit the rate limit");
  console.log("  ✓ write rate limit enforced (429 on burst)");
  await sleep(1100); // let the window clear before continuing

  // Recursive trash + restore.
  await paced(() => client.storage.moveFolderToTrash.mutate({ id: rootId! }));
  const trash = await paced(() => client.storage.listTrash.query());
  assert(
    trash.folders.some((f) => f.id === rootId),
    "root folder appears in trash",
  );
  console.log("  ✓ folder moved to trash (recursive)");

  await paced(() =>
    client.storage.restoreFolderFromTrash.mutate({ id: rootId! }),
  );
  const afterRestore = await paced(() => client.storage.listFiles.query());
  assert(
    afterRestore.folders.some((f) => f.id === rootId),
    "root folder restored",
  );
  console.log("  ✓ folder restored from trash");

  // Aggregation-backed stats.
  const stats = await paced(() => client.storage.getStats.query());
  assert(typeof stats.savedBytes === "number", "stats include savings");
  console.log(
    `  ✓ stats aggregation ran (files ${stats.totalFiles}, saved ${stats.savedBytesFormatted})`,
  );

  // Clean up: trash the tree, then hard-delete it.
  await paced(() => client.storage.moveFolderToTrash.mutate({ id: rootId! }));
  const emptied = await paced(() => client.storage.emptyTrash.mutate());
  assert(emptied.success, "empty trash succeeded");
  console.log(
    `  ✓ emptied trash (${emptied.deletedFolders} folders, ${emptied.deletedFiles} files)`,
  );

  console.log("\n=== smoke test passed ===\n");
}

main().catch((err) => {
  console.error("\n✗ smoke test failed:", err.message ?? err);
  process.exit(1);
});
