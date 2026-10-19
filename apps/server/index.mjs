// Vercel entry point. Serves the self-contained bundle that `tsdown` builds
// from src/index.ts (see tsdown.config.ts), so the deployment carries no
// node_modules. Local development runs src/index.ts directly.
//
// Vercel's Hono preset only accepts an entry whose source references "hono";
// the JSDoc type below satisfies that check without a runtime import.

// `bson` (via mongodb) asks `v8.startupSnapshot.isBuildingSnapshot()` while
// loading. Bun 1.3 throws "not yet implemented" there instead of answering, so
// answer for it: a running server is never building a V8 startup snapshot.
// This must run before the bundle is imported, hence the dynamic import below.
const getBuiltinModule = process.getBuiltinModule?.bind(process);
if (getBuiltinModule) {
  const v8 = getBuiltinModule("v8");
  let unsupported = false;
  try {
    v8?.startupSnapshot?.isBuildingSnapshot?.();
  } catch {
    unsupported = true;
  }
  if (unsupported) {
    const patchedV8 = {
      ...v8,
      startupSnapshot: { ...v8.startupSnapshot, isBuildingSnapshot: () => false },
    };
    process.getBuiltinModule = (id) =>
      id === "v8" || id === "node:v8" ? patchedV8 : getBuiltinModule(id);
  }
}

const { default: app } = await import("./dist/index.mjs");

/** @type {import("hono").Hono} */
const server = app;

export default server;
