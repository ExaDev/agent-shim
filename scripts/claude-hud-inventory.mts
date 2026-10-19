import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

/**
 * Bundles `scripts/claude-hud-inventory-run.ts` (which imports the parity inventory from `src/`) with esbuild into one ESM file and runs it, for the reason `gen-schema.mts` does: the package is CommonJS, so a bare `.ts` file cannot import `src/` modules directly. Arguments after the script name pass through: `node scripts/claude-hud-inventory.mts <claude-hud checkout> [--check]`.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const [major] = process.versions.node.split(".");
const outfile = path.join(distDir, "claude-hud-inventory-run.mjs");

fs.mkdirSync(distDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(__dirname, "claude-hud-inventory-run.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${major ?? ""}`,
  outfile,
  external: ["typescript"],
  logLevel: "warning",
});
await import(pathToFileURL(outfile).href);
