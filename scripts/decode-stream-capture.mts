import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Bundles `scripts/decode-stream-capture-core.ts` (which imports `src/frontdoor/wsFrames.ts`) with esbuild into a single ESM file, then runs it with the same arguments.
 *
 * The same indirection `scripts/gen-schema.mts` exists for: the package declares `"type": "commonjs"`, so a bare `.ts` file importing src via ESM `import` syntax cannot be loaded by Node's native TypeScript support, and bundling to a real `.mjs` output sidesteps that without changing the package's module type or duplicating the frame decoder.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

async function main(): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });
  const outfile = path.join(distDir, "decode-stream-capture-core.mjs");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "decode-stream-capture-core.ts")],
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
