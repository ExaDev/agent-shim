import path from "node:path";

import { CliError } from "./cliError";

/**
 * The directory the built library file sits in, which `scripts/build.mts` declares as a constant at the top of `dist/index.mjs` and `dist/index.cjs`. It is not declared in the CLI bundle or when the sources run unbuilt, so reading it is guarded by `typeof`.
 */
declare const __AGENT_SHIM_DIST_DIR__: string | undefined;

/** The file name of the command line bundle that ships beside the library files in `dist/`. */
export const OWN_CLI_FILE_NAME = "cli.cjs";

/** Raised by `agentShimCliPath` when the build does not record where the library was loaded from. */
export class OwnCliPathUnknownError extends CliError {
  constructor() {
    super("this agent-shim build does not record where it was loaded from, so the path of its command line bundle is unknown: pass the path of the agent-shim executable explicitly");
    this.name = "OwnCliPathUnknownError";
  }
}

/**
 * The path of the command line bundle (`dist/cli.cjs`) of the installed agent-shim package, found from where the library file itself was loaded, so a host that embeds the library can start the front door and headroom daemons through the same release without resolving the package manifest itself. Run it with Node: `spawn(process.execPath, [agentShimCliPath(), ...])`.
 *
 * `distDir` is the directory of the library file and exists for a caller or test that knows better; it defaults to the one the build recorded. Throws an `OwnCliPathUnknownError` when there is none, which is the case only when the sources run unbuilt.
 */
export function agentShimCliPath(distDir: string | undefined = typeof __AGENT_SHIM_DIST_DIR__ === "string" ? __AGENT_SHIM_DIST_DIR__ : undefined): string {
  if (distDir === undefined) {
    throw new OwnCliPathUnknownError();
  }
  return path.join(distDir, OWN_CLI_FILE_NAME);
}
