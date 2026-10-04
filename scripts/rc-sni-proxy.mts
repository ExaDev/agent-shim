import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Bundles `scripts/rc-sni-proxy-core.mts` (which imports the door's own `generateCa`/`mintLeaf` from `src/frontdoor/connect.ts`) with esbuild into a single ESM file, then runs it with the same arguments.
 *
 * The same indirection exists for `scripts/decode-stream-capture.mts`: the core's extensionless import of a `src/` module is fine for tsc and esbuild but not for Node's own ESM resolver, which resolves `../src/frontdoor/connect` to no file (ERR_MODULE_NOT_FOUND), so a direct `node scripts/rc-sni-proxy-core.mts` cannot work. Bundling to a real `.mjs` output sidesteps that without an explicit-extension import the repo's tsconfig does not allow, and it also keeps the rig's container copy free of any `node_modules`: the module subtree (node builtins plus zod) bundles to one self-contained file, where the library barrel would drag in CJS-only packages an ESM bundle cannot require.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

async function main(): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });
  const outfile = path.join(distDir, "rc-sni-proxy.mjs");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "rc-sni-proxy-core.mts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

await main();
