import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Bundles `scripts/rc-self-host-lab-run.ts` with esbuild into a single ESM file, then runs it with the same arguments: the indirection `scripts/decode-http-capture.mts` uses, because the package declares `"type": "commonjs"` and Node cannot load a `.ts` file that imports extensionless `.ts` siblings directly.
 *
 * See `rc-self-host-lab-run.ts` for the subcommands, what `up` prints, and the leak check.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

async function main(): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });
  const outfile = path.join(distDir, "rc-self-host-lab-run.mjs");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "rc-self-host-lab-run.ts")],
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
