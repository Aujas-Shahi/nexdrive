import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
  format: "esm",
  platform: "node",
  outDir: "./dist",
  clean: true,
  dts: false,
  // Bundle every dependency into one self-contained file so the deployment
  // never resolves packages at runtime: Vercel's file tracing does not follow
  // Bun's isolated-linker symlinks. Only `bun`, a runtime built-in, stays
  // external.
  deps: {
    alwaysBundle: [/^(?!bun$).*/],
    onlyBundle: false,
  },
});
