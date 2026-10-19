/**
 * Verify the seeded dataset through the real API: sign in as the demo user and
 * read back the aggregation-backed statistics and folder listing.
 *
 * Start the server first, then: `bun run scripts/verify-seed.ts`
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@nexdrive/api/routers/index";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL ?? "alice@nexdrive.test";
const PASSWORD = process.env.DEMO_PASSWORD ?? "password123";
const PACE_MS = 600;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  await sleep(PACE_MS);
  return fn();
}

async function main(): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie();
  console.log(`✓ logged in as ${EMAIL}`);

  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${SERVER_URL}/trpc`,
        headers: { Cookie: cookies.join("; ") },
      }),
    ],
  });

  const quota = await paced(() => client.storage.getQuota.query());
  console.log(
    `✓ quota: ${quota.storageUsedFormatted} / ${quota.storageLimitFormatted} (${quota.usagePercent.toFixed(1)}%)`,
  );

  const stats = await paced(() => client.storage.getStats.query());
  console.log("✓ stats:", {
    totalFiles: stats.totalFiles,
    dedupedFiles: stats.dedupedFiles,
    originalSize: stats.originalSizeFormatted,
    actualStorageUsed: stats.actualStorageUsedFormatted,
    savedBytes: stats.savedBytesFormatted,
    savedPercent: `${stats.savedPercent.toFixed(1)}%`,
  });

  const root = await paced(() => client.storage.listFiles.query());
  console.log(
    `✓ root listing: ${root.files.length} files, ${root.folders.length} folders`,
  );
  for (const folder of root.folders) {
    const contents = await paced(() =>
      client.storage.listFiles.query({ folderId: folder.id }),
    );
    console.log(
      `   ${folder.name}: ${contents.files.length} files, ${contents.folders.length} folders`,
    );
  }

  const trash = await paced(() => client.storage.listTrash.query());
  console.log(
    `✓ trash: ${trash.files.length} files, ${trash.folders.length} folders`,
  );
}

main().catch((err) => {
  console.error("✗ verify failed:", err.message ?? err);
  process.exit(1);
});
