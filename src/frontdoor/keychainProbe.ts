import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../credential";
import { realRunAsyncWithin } from "../realPorts";
import type { AsyncRun } from "../replayRun";
import type { ConfigApiDeps } from "./configApi";

/**
 * How the door asks the macOS Keychain whether a login is already filed for a directory: `security` run without blocking the event loop, stopped after `CREDENTIAL_COMMAND_TIMEOUT_MS`, and the platform, since only macOS has a Keychain.
 *
 * The bound is the one a non-interactive credential command has, because the lookup is the same non-interactive `security find-generic-password` that a credential source of the `keychain` kind runs: it answers at once or fails at once ("User interaction is not allowed") and never waits on a person. An interactive source has `CREDENTIAL_INTERACTIVE_TIMEOUT_MS` instead, since it may wait for approval, and this lookup never does. A `security` stopped at the bound ends as a `KeychainLookupError`. The command line puts no bound on `security`: a person is at the terminal and can interrupt it.
 *
 * `within` builds the runner for a bound, and is the real one except in a test that checks the bound.
 */
export function doorKeychainProbe(platform: NodeJS.Platform, within: (timeoutMs: number) => AsyncRun = realRunAsyncWithin): ConfigApiDeps["keychain"] {
  return { runAsync: within(CREDENTIAL_COMMAND_TIMEOUT_MS), platform };
}
