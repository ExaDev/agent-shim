import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Bundles `scripts/verify-claude-code-run.ts` with esbuild into a single ESM file, then runs it with the same arguments: the indirection `scripts/rc-self-host-lab.mts` uses, because Node cannot load a `.ts` file that imports extensionless `.ts` siblings directly.
 *
 * See `verify-claude-code-run.ts` for the subcommands and what a verification checks.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

async function main(): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });
  const outfile = path.join(distDir, "verify-claude-code-run.mjs");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "verify-claude-code-run.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    // esbuild is a build tool the run uses itself, to build the candidate bundle, so it stays a dependency the run imports rather than code bundled into it.
    external: ["esbuild"],
    logLevel: "silent",
  });
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

await main();
