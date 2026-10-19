import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  BarChart3,
  Download,
  FolderTree,
  PieChart,
  Share2,
  Trophy,
} from "lucide-react";

import { DashboardHeader } from "@/components/dashboard/header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatBytes } from "@/lib/utils";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard/insights")({
  component: InsightsView,
  loader: async ({ context }) => {
    // Prefetch every report before rendering; each is a single aggregation.
    await Promise.all([
      context.queryClient.ensureQueryData(
        context.trpc.analytics.dedupReport.queryOptions(),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.analytics.storageByType.queryOptions(),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.analytics.uploadActivity.queryOptions(),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.analytics.topShared.queryOptions(),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.analytics.folderTree.queryOptions(),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.analytics.topUsers.queryOptions(),
      ),
    ]);
  },
});

/** Friendly labels for the MIME types the app actually stores. */
const TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/zip": "ZIP",
  "application/json": "JSON",
  "text/plain": "TXT",
  "text/csv": "CSV",
  "text/markdown": "MD",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "image/svg+xml": "SVG",
  "video/mp4": "MP4",
  "audio/mpeg": "MP3",
  "audio/wav": "WAV",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PPTX",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
};

/** Turn a MIME type into a short label, e.g. `image/png` → `PNG`. */
function typeLabel(contentType: string): string {
  if (contentType === "unknown") return "Unknown";
  const known = TYPE_LABELS[contentType];
  if (known) return known;
  const subtype = (contentType.split("/")[1] ?? contentType).split("+")[0]!;
  return subtype.length > 18 ? `${subtype.slice(0, 15)}…` : subtype.toUpperCase();
}

interface TreeRow {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  descendants: number;
}

/** Recursive folder branch for the $graphLookup tree. */
function FolderBranch({
  node,
  childrenByParent,
}: {
  node: TreeRow;
  childrenByParent: Map<string, TreeRow[]>;
}) {
  const children = childrenByParent.get(node.id) ?? [];
  return (
    <li>
      <div className="flex items-center justify-between">
        <span>{node.name}</span>
        <span className="text-muted-foreground">
          {node.descendants} subfolder{node.descendants === 1 ? "" : "s"}
        </span>
      </div>
      {children.length > 0 && (
        <ul className="mt-1 space-y-1 border-l pl-4">
          {children.map((child) => (
            <FolderBranch
              key={child.id}
              node={child}
              childrenByParent={childrenByParent}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A simple, dependency-free horizontal bar. */
function Bar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  return (
    <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
      <div
        className="bg-primary h-full rounded-full"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function InsightsView() {
  const trpc = useTRPC();

  const dedupQuery = useQuery(trpc.analytics.dedupReport.queryOptions());
  const byTypeQuery = useQuery(trpc.analytics.storageByType.queryOptions());
  const activityQuery = useQuery(trpc.analytics.uploadActivity.queryOptions());
  const sharedQuery = useQuery(trpc.analytics.topShared.queryOptions());
  const treeQuery = useQuery(trpc.analytics.folderTree.queryOptions());
  const leadersQuery = useQuery(trpc.analytics.topUsers.queryOptions());

  const dedup = dedupQuery.data;
  const byType = byTypeQuery.data ?? [];
  const activity = activityQuery.data ?? [];
  const shared = sharedQuery.data ?? [];
  const tree = treeQuery.data ?? [];
  const leaders = leadersQuery.data ?? [];

  // Assemble the flat $graphLookup rows into a nested tree for rendering.
  const treeIds = new Set(tree.map((node) => node.id));
  const childrenByParent = new Map<string, TreeRow[]>();
  const treeRoots: TreeRow[] = [];
  for (const node of tree) {
    if (!node.parentId || !treeIds.has(node.parentId)) {
      treeRoots.push(node);
    } else {
      const siblings = childrenByParent.get(node.parentId) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentId, siblings);
    }
  }

  const maxTypeBytes = Math.max(...byType.map((row) => row.bytes), 1);
  const maxActivityBytes = Math.max(...activity.map((row) => row.bytes), 1);
  const maxLeaderBytes = Math.max(...leaders.map((row) => row.logicalBytes), 1);

  return (
    <>
      <DashboardHeader breadcrumbs={[{ label: "Insights" }]} />

      <div className="flex-1 space-y-6 overflow-auto p-4">
        <div>
          <h1 className="text-2xl font-semibold">Insights</h1>
          <p className="text-muted-foreground text-sm">
            Live aggregations over the MongoDB collections.
          </p>
        </div>

        {/* Deduplication savings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PieChart className="size-5" />
              Deduplication savings
            </CardTitle>
            <CardDescription>
              Logical bytes (what every claim would cost) versus physical bytes
              actually stored.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dedup ? (
              <>
                <div className="grid gap-4 sm:grid-cols-4">
                  <Stat label="Unique blobs" value={String(dedup.blobs)} />
                  <Stat label="Total claims" value={String(dedup.claims)} />
                  <Stat
                    label="Logical size"
                    value={formatBytes(dedup.logicalBytes)}
                  />
                  <Stat
                    label="Physical size"
                    value={formatBytes(dedup.physicalBytes)}
                  />
                </div>
                <div className="mt-6 space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-muted-foreground text-sm">
                      Storage saved
                    </span>
                    <span className="text-sm font-medium">
                      {formatBytes(dedup.savedBytes)} ·{" "}
                      {dedup.savedPercent.toFixed(1)}% ·{" "}
                      {dedup.dedupRatio.toFixed(2)}×
                    </span>
                  </div>
                  <Bar value={dedup.savedBytes} max={dedup.logicalBytes} />
                </div>

                {dedup.topDuplicated.length > 0 && (
                  <div className="mt-6">
                    <p className="text-muted-foreground mb-2 text-sm font-medium">
                      Most duplicated blobs
                    </p>
                    <div className="space-y-2">
                      {dedup.topDuplicated.slice(0, 5).map((blob) => (
                        <div
                          key={blob.hash}
                          className="flex items-center justify-between text-sm"
                        >
                          <code className="text-muted-foreground">
                            {blob.hash.slice(0, 12)}…
                          </code>
                          <span>
                            {formatBytes(blob.size)} × {blob.refCount} claims
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <Empty />
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Storage by type */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="size-5" />
                Storage by content type
              </CardTitle>
              <CardDescription>Your files, grouped by MIME type.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {byType.length > 0 ? (
                byType.map((row) => (
                  <div key={row.contentType} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{typeLabel(row.contentType)}</span>
                      <span className="text-muted-foreground">
                        {row.files} · {formatBytes(row.bytes)}
                      </span>
                    </div>
                    <Bar value={row.bytes} max={maxTypeBytes} />
                  </div>
                ))
              ) : (
                <Empty />
              )}
            </CardContent>
          </Card>

          {/* Upload activity */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="size-5" />
                Upload activity
              </CardTitle>
              <CardDescription>Files and bytes added per day.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {activity.length > 0 ? (
                activity.map((row) => (
                  <div key={row.date} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{row.date}</span>
                      <span className="text-muted-foreground">
                        {row.files} · {formatBytes(row.bytes)}
                      </span>
                    </div>
                    <Bar value={row.bytes} max={maxActivityBytes} />
                  </div>
                ))
              ) : (
                <Empty />
              )}
            </CardContent>
          </Card>

          {/* Folder tree */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderTree className="size-5" />
                Folder tree
              </CardTitle>
              <CardDescription>
                Depth and subtree size, computed with $graphLookup.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {treeRoots.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {treeRoots.map((node) => (
                    <FolderBranch
                      key={node.id}
                      node={node}
                      childrenByParent={childrenByParent}
                    />
                  ))}
                </ul>
              ) : (
                <Empty />
              )}
            </CardContent>
          </Card>

          {/* Top shared */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Share2 className="size-5" />
                Most downloaded shares
              </CardTitle>
              <CardDescription>Public files across all users.</CardDescription>
            </CardHeader>
            <CardContent>
              {shared.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {shared.map((row) => (
                    <li
                      key={row.id}
                      className="flex items-center justify-between"
                    >
                      <span className="truncate">
                        {row.name}
                        <span className="text-muted-foreground">
                          {" "}
                          · {row.owner ?? "unknown"}
                        </span>
                      </span>
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Download className="size-3.5" />
                        {row.downloadCount}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Leaderboard */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="size-5" />
              Storage leaderboard
            </CardTitle>
            <CardDescription>
              Logical bytes per user, with distinct-blob counts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {leaders.length > 0 ? (
              leaders.map((row) => (
                <div key={row.userId} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>{row.name ?? row.userId}</span>
                    <span className="text-muted-foreground">
                      {row.files} claims · {row.uniqueFiles} unique ·{" "}
                      {formatBytes(row.logicalBytes)}
                    </span>
                  </div>
                  <Bar value={row.logicalBytes} max={maxLeaderBytes} />
                </div>
              ))
            ) : (
              <Empty />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function Empty() {
  return (
    <p className="text-muted-foreground py-6 text-center text-sm">
      No data yet.
    </p>
  );
}
