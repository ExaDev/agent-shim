import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

/**
 * Bundles `scripts/headroom-measure-run.ts` (which imports `src/headroom/settings.ts` and `zod`) with esbuild into one ESM file, then runs it with this process's arguments. The indirection is the one `gen-schema.mts` uses: `package.json` declares `"type": "commonjs"`, so Node cannot load a `.ts` file that imports other extensionless `.ts` files directly.
 *
 * See `headroom-measure-run.ts` for what it measures and its options.
 */
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptsDir, "..", "dist");

function currentNodeMajor(): string {
  const [major] = process.versions.node.split(".");
  if (major === undefined) {
    throw new Error(`Could not parse a major version from process.versions.node (${process.versions.node}).`);
  }
  return major;
}

fs.mkdirSync(distDir, { recursive: true });
const outfile = path.join(distDir, "headroom-measure-run.mjs");
await esbuild.build({
  entryPoints: [path.join(scriptsDir, "headroom-measure-run.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${currentNodeMajor()}`,
  outfile,
  external: ["zod"],
  logLevel: "error",
});
await import(pathToFileURL(outfile).href);
