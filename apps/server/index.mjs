// Vercel entry point. Serves the self-contained bundle that `tsdown` builds
// from src/index.ts (see tsdown.config.ts), so the deployment carries no
// node_modules. Local development runs src/index.ts directly.
//
// Vercel's Hono preset only accepts an entry whose source references "hono";
// the JSDoc type below satisfies that check without a runtime import.
import app from "./dist/index.mjs";

/** @type {import("hono").Hono} */
const server = app;

export default server;
