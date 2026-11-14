/** The Claude Code versions the control plugin and the door's goal, compaction and turn routes were verified on end to end (`docs/rc-slash-commands.md`). A version on the list is gated through silently; how every other version is gated is `claudeCodeVersionGate`'s decision. */
export const RC_SESSION_COMMAND_VERIFIED_VERSIONS: readonly string[] = ["2.1.319", "2.1.325"];

/** A plain dotted-numeric release version such as `2.1.325`: what the gate lists and the launcher pins. Prereleases and builds are never release versions. */
const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

/** A release version's parts. */
export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** The parts of a plain release version, or undefined when `version` is not one. The one parser of the versions the gate compares. */
export function parseReleaseVersion(version: string): ReleaseVersion | undefined {
  const match = RELEASE_VERSION.exec(version);
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** The `major.minor` a release version belongs to. */
function minorOf(version: ReleaseVersion): string {
  return `${String(version.major)}.${String(version.minor)}`;
}

/** The minors of the verified versions, each once, in list order; throws on a listed version that is not a release version, which `record` never writes. */
function verifiedMinors(): readonly string[] {
  return [...new Set(RC_SESSION_COMMAND_VERIFIED_VERSIONS.map((listed) => {
    const parsed = parseReleaseVersion(listed);
    if (parsed === undefined) {
      throw new Error(`RC_SESSION_COMMAND_VERIFIED_VERSIONS lists ${listed}, which is not a plain release version`);
    }
    return minorOf(parsed);
  }))];
}

/**
 * How the goal, compaction and turn verbs and an unsupervised launch's control plugin treat one Claude Code version:
 *
 * - `verified`: the version is on `RC_SESSION_COMMAND_VERIFIED_VERSIONS`, and everything proceeds with no warning.
 * - `unverified-patch`: the version is not on the list but shares its major and minor with a version that is (a patch release of a verified minor), and everything proceeds carrying `warning`, which names the version and says it has not been verified.
 * - `refused`: any other version, one that is not a plain release version, or none known; nothing proceeds.
 */
export type ClaudeCodeVersionGate = { readonly kind: "verified" } | { readonly kind: "unverified-patch"; readonly warning: string } | { readonly kind: "refused" };

/** The one decision every gate site takes on a running Claude Code version (`ClaudeCodeVersionGate`); `version` is undefined when the running binary has not reported one. */
export function claudeCodeVersionGate(version: string | undefined): ClaudeCodeVersionGate {
  if (version === undefined) {
    return { kind: "refused" };
  }
  if (RC_SESSION_COMMAND_VERIFIED_VERSIONS.includes(version)) {
    return { kind: "verified" };
  }
  const parsed = parseReleaseVersion(version);
  if (parsed === undefined || !verifiedMinors().includes(minorOf(parsed))) {
    return { kind: "refused" };
  }
  return { kind: "unverified-patch", warning: `Claude Code ${version} has not been verified for goal, compaction and turn control (verified: ${RC_SESSION_COMMAND_VERIFIED_VERSIONS.join(", ")}); it is a patch release of verified minor ${minorOf(parsed)}, so the control plugin and the verbs run on it unchecked` };
}

/** The versions the gate lets through, in words, for a refusal or a command's description: the verified versions, and the other patch releases of their minors. */
export function claudeCodeVersionsGated(): string {
  return `Claude Code ${RC_SESSION_COMMAND_VERIFIED_VERSIONS.join(", ")}, or another patch release of ${verifiedMinors().join(" or ")} with a warning that it is unverified`;
}
