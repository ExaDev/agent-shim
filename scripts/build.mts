import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

/**
 * Bundles `src/cli.ts` with esbuild into a single CJS file, then — unless `--bundle-only` is given — invokes the now-stable `node --build-sea=<config>` single command (Node v25.5.0 or later) to produce a self-contained single-executable-application binary.
 *
 * This deliberately does NOT use the older `--experimental-sea-config` + manual `postject` pipeline the README used to describe — `--build-sea` handles bundle-copy, signature removal, blob injection, and re-signing in one step, and postject is not a dependency of this project.
 *
 * macOS SEA support is verified/tested upstream on arm64 only; x64 is explicitly unsupported and skipped in Node's own test suite. This script builds for whatever architecture it runs on and does not claim portability beyond that — a later CI phase attempts x64 as clearly-labelled best-effort, separate from this local build.
 *
 * `--bundle-only` produces just `dist/cli.cjs` (with a `#!/usr/bin/env node` shebang) and skips every SEA-specific step — this is what `npm publish`'s own `prepublishOnly` script runs, since the npm-distributed package needs the plain bundle to execute under the installer's own Node, not a platform-specific native binary with an embedded runtime.
 */
const bundleOnly = process.argv.includes("--bundle-only");

/** The lowest Node version this bundle is ever asked to run under — set by `commander@15`'s own `engines.node`, the strictest floor among this project's runtime dependencies, and mirrored in package.json's own `engines` field. Fixed rather than tied to whichever Node version happens to run this build script: the SEA binary embeds its own runtime regardless, and the npm-published bundle runs under whatever Node the installer has, which is only guaranteed to be at least this floor. */
const ESBUILD_TARGET = "node22";

/** The CommonJS bundle's stand-in for `import.meta.url`, declared by its banner and substituted for every bundled ES module's use of it. */
const IMPORT_META_URL_VARIABLE = "__agentShimImportMetaUrl";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const bundleFileName = "cli.cjs";
const seaConfigFileName = "sea-config.json";
const EXECUTABLE_FILE_MODE = 0o755;
const outputBinaryName = process.platform === "win32" ? "agent-shim-sea.exe" : "agent-shim-sea";

// node --build-sea's stable single-command form shipped in this release.
const MIN_BUILD_SEA_NODE_MAJOR = 25;
const MIN_BUILD_SEA_NODE_MINOR = 5;

function requireBuildSeaSupport(): void {
  const [major, minor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const supported =
    major !== undefined &&
    minor !== undefined &&
    (major > MIN_BUILD_SEA_NODE_MAJOR || (major === MIN_BUILD_SEA_NODE_MAJOR && minor >= MIN_BUILD_SEA_NODE_MINOR));
  if (!supported) {
    throw new Error(
      `node --build-sea requires Node >= v25.5.0 (this stable single-command form shipped there); ` +
        `running Node v${process.versions.node}. Confirm the installed Node version before building.`,
    );
  }
}

async function bundle(): Promise<void> {
  await esbuild.build({
    entryPoints: [path.join(rootDir, "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ESBUILD_TARGET,
    outfile: path.join(distDir, bundleFileName),
    // A shebang is inert for the SEA build (Node's CommonJS loader strips a leading `#!` line from any entry point regardless) and required for the npm-published bin script to be directly executable. The second line gives bundled ES modules an `import.meta.url`, which a CommonJS bundle otherwise leaves undefined: the Agent SDK passes it to `createRequire`. It names the running script, or the executable itself under SEA.
    banner: { js: `#!/usr/bin/env node\nconst ${IMPORT_META_URL_VARIABLE} = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;` },
    define: { "import.meta.url": IMPORT_META_URL_VARIABLE },
    minify: false,
    logLevel: "info",
  });
  fs.chmodSync(path.join(distDir, bundleFileName), EXECUTABLE_FILE_MODE);
}

/**
 * Builds the library surface (`src/index.ts`) alongside the CLI bundle: an ESM and a CJS file with every dependency left external, so a consumer installs them through this package's own `dependencies` rather than receiving copies, plus declaration files from `tsconfig.lib.json`. Unlike `cli.cjs`, nothing here is bundled for self-containment, and nothing reachable from `src/index.ts` imports `commander` or `@clack/prompts`; `assertNoCliOnlyImports` fails the build if that stops being true.
 */
async function buildLibrary(): Promise<void> {
  for (const [format, extension] of [["esm", "mjs"], ["cjs", "cjs"]] as const) {
    const result = await esbuild.build({
      entryPoints: [path.join(rootDir, "src", "index.ts")],
      bundle: true,
      packages: "external",
      platform: "node",
      format,
      target: ESBUILD_TARGET,
      outfile: path.join(distDir, `index.${extension}`),
      metafile: true,
      logLevel: "info",
    });
    assertNoCliOnlyImports(result.metafile);
  }
  await bundleDeclarations();
}

/**
 * Bundles the library's declarations into the single `dist/types/index.d.ts`. Per-file declarations keep the source's extensionless relative imports, which a consumer on `module: NodeNext` cannot resolve: every type the package exports then reads as an error type. One file has no relative imports to resolve.
 */
async function bundleDeclarations(): Promise<void> {
  const declarations = await rollup({ input: path.join(rootDir, "src", "index.ts"), plugins: [dts({ tsconfig: path.join(rootDir, "tsconfig.lib.json") })], external: (id) => !id.startsWith(".") && !path.isAbsolute(id) });
  await declarations.write({ file: path.join(distDir, "types", "index.d.ts"), format: "es" });
  await declarations.close();
  const relative = /\bfrom\s+["']\.{1,2}\//.exec(fs.readFileSync(path.join(distDir, "types", "index.d.ts"), "utf8"));
  if (relative !== null) {
    throw new Error(`the bundled declarations still import a relative path (${relative[0]}), which a NodeNext consumer cannot resolve`);
  }
}

/** Dependencies that exist for the command line alone. The library must work for a consumer that has installed neither. */
const CLI_ONLY_PACKAGES = ["commander", "@clack/prompts"] as const;

function assertNoCliOnlyImports(metafile: esbuild.Metafile): void {
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (CLI_ONLY_PACKAGES.some((name) => imported.path === name || imported.path.startsWith(`${name}/`))) {
        throw new Error(`the library bundle imports ${imported.path}, which only the CLI should depend on`);
      }
    }
  }
}

function writeSeaConfig(): string {
  const seaConfigPath = path.join(distDir, seaConfigFileName);
  // Schema per https://nodejs.org/api/single-executable-applications.html — every field here is read directly from that page, not guessed. Paths are relative to `distDir`, since that is where `node --build-sea=` is invoked from below.
  const seaConfig = {
    main: bundleFileName,
    output: outputBinaryName,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`);
  return seaConfigPath;
}

function hasStderr(error: unknown): error is Error & { stderr: unknown } {
  return error instanceof Error && "stderr" in error;
}

function buildSea(seaConfigPath: string): string {
  const outputPath = path.join(distDir, outputBinaryName);
  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath);
  }
  try {
    execFileSync(process.execPath, [`--build-sea=${path.basename(seaConfigPath)}`], {
      cwd: distDir,
      stdio: ["ignore", "inherit", "pipe"],
    });
  } catch (error) {
    const stderr = hasStderr(error) ? String(error.stderr) : "";
    if (stderr.includes("Single executable application is disabled")) {
      throw new Error(
        `${process.execPath} was built with the single-executable-application feature disabled ` +
          "(confirmed on Homebrew's macOS Node distribution). Re-run this build with a Node binary " +
          "from a distribution that supports it — the official nodejs.org build, or a version " +
          "manager installing upstream builds (mise, nvm, volta, fnm) — ahead of it on PATH.",
        { cause: error },
      );
    }
    if (stderr.length > 0) {
      console.error(stderr);
    }
    throw error;
  }

  if (process.platform === "darwin") {
    // SEA binaries must be re-signed on macOS after blob injection invalidates the original signature. Ad-hoc signing (`-`) is sufficient for local use and for CI runners; a real release build may want a proper Developer ID signature instead, added in a later phase.
    execFileSync("codesign", ["--sign", "-", outputPath], { stdio: "inherit" });
  }

  fs.chmodSync(outputPath, EXECUTABLE_FILE_MODE);
  return outputPath;
}

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;

function reportSize(outputPath: string): void {
  const { size } = fs.statSync(outputPath);
  const mib = size / BYTES_PER_MIB;
  console.log(`Built ${outputPath} (${mib.toFixed(1)} MiB)`);
}

async function main(): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });
  await bundle();
  await buildLibrary();
  if (bundleOnly) {
    reportSize(path.join(distDir, bundleFileName));
    return;
  }
  requireBuildSeaSupport();
  const seaConfigPath = writeSeaConfig();
  const outputPath = buildSea(seaConfigPath);
  reportSize(outputPath);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
