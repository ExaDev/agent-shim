import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../credential";
import { realRunAsyncWithin } from "../realPorts";
import type { AsyncRun } from "../replayRun";
import type { ConfigApiDeps } from "./configApi";

/**
 * How the door asks the macOS Keychain whether a login is already filed for a directory: `security` run without blocking the event loop, stopped after `CREDENTIAL_COMMAND_TIMEOUT_MS`, and the platform, since only macOS has a Keychain.
 *
 * The lookup runs the same `security find-generic-password` subcommand a `keychain` credential source runs, but without `-w`, so it reads the item's attributes only, never asks for access to the secret and never waits on a person. The bound is therefore the one a non-interactive credential command has (`CREDENTIAL_COMMAND_TIMEOUT_MS`), not the longer `CREDENTIAL_INTERACTIVE_TIMEOUT_MS` of a source that may wait for approval. A `security` stopped at the bound ends as a `KeychainLookupError`. The command line puts no bound on `security`: a person is at the terminal and can interrupt it.
 *
 * `within` builds the runner for a bound, and is the real one except in a test that checks the bound.
 */
export function doorKeychainProbe(platform: NodeJS.Platform, within: (timeoutMs: number) => AsyncRun = realRunAsyncWithin): ConfigApiDeps["keychain"] {
  return { runAsync: within(CREDENTIAL_COMMAND_TIMEOUT_MS), platform };
}
