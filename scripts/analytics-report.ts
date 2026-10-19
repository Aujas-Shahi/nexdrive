/**
 * Print every analytics aggregation for the demo user.
 *
 * Start the server first, then: `bun run scripts/analytics-report.ts`
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@nexdrive/api/routers/index";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL ?? "alice@nexdrive.test";
const PASSWORD = process.env.DEMO_PASSWORD ?? "password123";

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

async function main(): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookies = res.headers.getSetCookie();

  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${SERVER_URL}/trpc`,
        headers: { Cookie: cookies.join("; ") },
      }),
    ],
  });

  const dedup = await client.analytics.dedupReport.query();
  console.log("\n1. Global dedup report");
  console.log(`   blobs: ${dedup.blobs} | claims: ${dedup.claims}`);
  console.log(
    `   logical ${mb(dedup.logicalBytes)} vs physical ${mb(dedup.physicalBytes)} → ` +
      `saved ${mb(dedup.savedBytes)} (${dedup.savedPercent.toFixed(1)}%), ratio ${dedup.dedupRatio.toFixed(2)}×`,
  );
  console.log("   most duplicated blobs:");
  for (const blob of dedup.topDuplicated.slice(0, 5)) {
    console.log(
      `     ${blob.hash.slice(0, 12)}… size ${mb(blob.size)} × ${blob.refCount} claims`,
    );
  }

  const byType = await client.analytics.storageByType.query();
  console.log("\n2. Storage by content type (Alice)");
  for (const row of byType) {
    console.log(`   ${row.contentType}: ${row.files} files, ${mb(row.bytes)}`);
  }

  const activity = await client.analytics.uploadActivity.query();
  console.log("\n3. Upload activity (Alice)");
  for (const row of activity) {
    console.log(`   ${row.date}: ${row.files} files, ${mb(row.bytes)}`);
  }

  const shared = await client.analytics.topShared.query();
  console.log("\n4. Most downloaded public files");
  for (const row of shared) {
    console.log(
      `   ${row.name} — ${row.downloadCount} downloads (${row.owner ?? "unknown"})`,
    );
  }

  const tree = await client.analytics.folderTree.query();
  console.log("\n5. Folder tree (Alice) — $graphLookup");
  for (const row of tree) {
    console.log(
      `   ${"  ".repeat(row.depth)}${row.name} (depth ${row.depth}, ${row.descendants} descendants)`,
    );
  }

  const leaders = await client.analytics.topUsers.query();
  console.log("\n6. Storage leaderboard");
  for (const row of leaders) {
    console.log(
      `   ${row.name}: ${row.files} claims, ${row.uniqueFiles} unique blobs, ${mb(row.logicalBytes)}`,
    );
  }
}

main().catch((err) => {
  console.error("✗ analytics report failed:", err.message ?? err);
  process.exit(1);
});
