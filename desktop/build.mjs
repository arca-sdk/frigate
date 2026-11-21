// Bundles the main process, the server list preload and the server list page
// into dist/. Sandboxed preloads can't require local files, so each entry is
// a single bundle.
import { cp, rm } from "node:fs/promises";

import { build } from "esbuild";

const common = {
  bundle: true,
  sourcemap: true,
  target: "es2023",
  logLevel: "warning",
};

await rm("dist", { recursive: true, force: true });

await Promise.all([
  build({
    ...common,
    entryPoints: { main: "src/main/main.ts" },
    outdir: "dist",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: { preload: "src/preload/serverList.ts" },
    outdir: "dist",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: { serverList: "src/renderer/serverList.ts" },
    outdir: "dist/renderer",
    platform: "browser",
    format: "iife",
  }),
]);

await cp("src/renderer/index.html", "dist/renderer/index.html");
await cp("src/renderer/serverList.css", "dist/renderer/serverList.css");
