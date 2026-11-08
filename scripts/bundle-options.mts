import path from "node:path";

import type * as esbuild from "esbuild";

/** The lowest Node version this bundle is ever asked to run under — set by `commander@15`'s own `engines.node`, the strictest floor among this project's runtime dependencies, and mirrored in package.json's own `engines` field. Fixed rather than tied to whichever Node version happens to run this build script: the SEA binary embeds its own runtime regardless, and the npm-published bundle runs under whatever Node the installer has, which is only guaranteed to be at least this floor. */
export const ESBUILD_TARGET = "node22";

/** The CommonJS bundle's stand-in for `import.meta.url`, declared by its banner and substituted for every bundled ES module's use of it. */
const IMPORT_META_URL_VARIABLE = "__agentShimImportMetaUrl";

/**
 * The options the release bundles the command line with (everything but the output file), shared by `scripts/build.mts` and the tests that must build exactly what the release builds.
 */
export function cliBundleOptions(rootDir: string): esbuild.BuildOptions {
  return {
    entryPoints: [path.join(rootDir, "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ESBUILD_TARGET,
    // A shebang is inert for the SEA build (Node's CommonJS loader strips a leading `#!` line from any entry point regardless) and required for the npm-published bin script to be directly executable. The second line gives bundled ES modules an `import.meta.url`, which a CommonJS bundle otherwise leaves undefined: the Agent SDK passes it to `createRequire`. It names the running script, or the executable itself under SEA.
    banner: { js: `#!/usr/bin/env node\nconst ${IMPORT_META_URL_VARIABLE} = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;` },
    define: { "import.meta.url": IMPORT_META_URL_VARIABLE },
    // No `keepNames` and no minifying: `src/frontdoor/probe.ts` embeds the source text of functions from this bundle in its worker threads, which can run only code that refers to nothing but its own parameters. `keepNames` would inject calls to a `__name` helper that exists only in the bundle and the worker would throw a ReferenceError; `src/frontdoor/probe.test.ts` builds with these options and fails if that happens.
    minify: false,
  };
}
