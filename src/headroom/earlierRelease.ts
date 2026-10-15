import { isHttpProvider, type Provider } from "../config/schema";
import { frontDoorOrigin, readFrontDoorState } from "../frontdoor/state";
import type { LayoutPaths } from "../paths";
import { HEADROOM_ALLOWLIST_FILE_FLAG, hashAllowlist, readAllProviders, type HeadroomFs } from "./state";

/**
 * What a daemon's command line (as `ps` reports it) says the process is. Only a `headroom ... proxy` serving our own socket (`--uds <socketPath>`) is judged: with `--allowed-base-urls-file` it is this release's daemon, and without it an earlier release's, whose allowlist is fixed for the daemon's life and whose recorded `allowlistHash` is `earlierReleaseAllowlistHash` (the state file has no field saying which release wrote it, so the daemon's own arguments are the evidence). Anything else is `not-headroom`, a pid the system has since given to another process, and an unreadable command line (the pid has gone, there is no `ps`, or it did not answer in time) is `unreadable`; neither is ever taken for an earlier release.
 */
export type DaemonIdentity = "this-release" | "earlier-release" | "not-headroom" | "unreadable";

/**
 * The command line with our `--uds <socketPath>` (or `--uds=<socketPath>`) argument cut out, or undefined when it has none. `ps` joins arguments with spaces, so a state root whose path holds a space would split a socket path apart; matching the recorded path as a whole, bounded by the start or a space before and the end or a space after, finds it however many spaces it holds.
 */
function withoutOurSocket(commandLine: string, socketPath: string): string | undefined {
  for (const argument of [`--uds ${socketPath}`, `--uds=${socketPath}`]) {
    let from = 0;
    for (;;) {
      const index = commandLine.indexOf(argument, from);
      if (index === -1) {
        break;
      }
      const end = index + argument.length;
      const startsArgument = index === 0 || /\s/.test(commandLine.charAt(index - 1));
      const endsArgument = end === commandLine.length || /\s/.test(commandLine.charAt(end));
      if (startsArgument && endsArgument) {
        return `${commandLine.slice(0, index)} ${commandLine.slice(end)}`;
      }
      from = index + 1;
    }
  }
  return undefined;
}

/** Classifies a daemon's command line (see `DaemonIdentity`) against the socket the state records it serving on. */
export function daemonIdentity(commandLine: string | undefined, socketPath: string): DaemonIdentity {
  if (commandLine === undefined) {
    return "unreadable";
  }
  const rest = withoutOurSocket(commandLine, socketPath);
  // The other arguments are judged with our socket path cut out, so nothing inside the path can pass for one.
  const argumentsList = rest === undefined ? [] : rest.trim().split(/\s+/);
  if (rest === undefined || !argumentsList.includes("proxy")) {
    return "not-headroom";
  }
  return argumentsList.some((argument) => argument === HEADROOM_ALLOWLIST_FILE_FLAG || argument.startsWith(`${HEADROOM_ALLOWLIST_FILE_FLAG}=`)) ? "this-release" : "earlier-release";
}

/** The message for a daemon started by an earlier release whose fixed allowlist does not admit the serving door: nothing can rewrite it, and its supervisor restarts it (on the current allowlist) only once no session is registered against it. */
export const EARLIER_RELEASE_ALLOWLIST = "started by an earlier release with an allowlist fixed at start; it restarts once its sessions end";

/** The upstream an earlier release's allowlist always held: Claude Code's own API. */
const EARLIER_RELEASE_ANTHROPIC_UPSTREAM = "https://api.anthropic.com";

/**
 * The `allowlistHash` a supervisor from an earlier release records for its daemon: the hash of the sorted list, without repeats, of Claude Code's own API, every http provider's full base URL, and the front door's direct origin while any provider exists. That release computed it from the provider files and the door's `state.json` origin, and nothing else may use this formula: it exists only to recognise such a daemon's record.
 */
export function earlierReleaseAllowlistHash(providers: readonly Provider[], doorOrigin: string | undefined): string {
  const entries = new Set<string>([EARLIER_RELEASE_ANTHROPIC_UPSTREAM]);
  for (const provider of providers) {
    if (isHttpProvider(provider)) {
      entries.add(provider.baseUrl);
    }
  }
  if (providers.length > 0 && doorOrigin !== undefined) {
    entries.add(doorOrigin);
  }
  return hashAllowlist([...entries].sort());
}

/** What is known of a daemon started by an earlier release: whether its fixed allowlist admits the door `state.json` names now. */
export interface EarlierReleaseDaemon {
  readonly admitsServingDoor: boolean;
}

/**
 * The one place that decides what a daemon started by an earlier release admits: undefined unless `daemonIdentity` judges the daemon an earlier release's (this release's, an unreadable command line, and a reused pid are all left to the caller), and otherwise whether its recorded hash is the one that release records for the providers and door on disk now, which means its fixed allowlist holds the serving door's direct origin. Any other hash means the door moved, or a provider changed, since that daemon started.
 */
export function earlierReleaseDaemon(
  fs: HeadroomFs,
  paths: LayoutPaths,
  daemon: { readonly commandLine: string | undefined; readonly socketPath: string; readonly recordedHash: string | undefined },
): EarlierReleaseDaemon | undefined {
  if (daemonIdentity(daemon.commandLine, daemon.socketPath) !== "earlier-release") {
    return undefined;
  }
  const providers = readAllProviders(fs, paths.providersDir).map((entry) => entry.provider);
  const expected = earlierReleaseAllowlistHash(providers, frontDoorOrigin(readFrontDoorState(fs, paths.frontdoorStateFile)));
  return { admitsServingDoor: daemon.recordedHash === expected };
}
