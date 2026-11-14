/**
 * The pure half of `scripts/verify-claude-code.mts`: which Claude Code releases are newer than the verified ones, which registry package carries a release's binary for a platform, whether a downloaded tarball is the one the registry describes, what each lab check expects of a verb's answer, and how the verified versions are written into the gate and its document. Everything here takes values and returns values, so it is unit-tested without the registry, a lab or a CLI.
 */
import { createHash } from "node:crypto";

import type { LabRoute } from "./rc-self-host-lab-core";

/** The package Claude Code is published as; its per-platform binaries are its optional dependencies, each named after it with the platform appended. */
export const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";

/** A plain dotted-numeric release version such as `2.1.325`: what the gate lists and the launcher pins. Prereleases and builds are never candidates. */
const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Whether `version` is a plain release version. */
export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version);
}

/** Orders two release versions numerically, part by part: negative when `a` is older. */
export function compareReleaseVersions(a: string, b: string): number {
  const parts = (version: string): readonly number[] => version.split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** The newest of the verified versions, failing on an empty list. */
export function newestVersion(verified: readonly string[]): string {
  const newest = [...verified].sort(compareReleaseVersions).at(-1);
  if (newest === undefined) {
    throw new Error("the verified versions list is empty, so there is nothing to be newer than");
  }
  return newest;
}

/** The published release versions newer than every verified one, oldest first: what a scheduled run verifies. */
export function versionsNewerThanVerified(published: readonly string[], verified: readonly string[]): readonly string[] {
  const newest = newestVersion(verified);
  return published.filter((version) => isReleaseVersion(version) && compareReleaseVersions(version, newest) > 0).sort(compareReleaseVersions);
}

/** The platform facts that choose a binary package: Node's own names for the operating system and architecture, and whether the C library is musl. */
export interface ClaudeCodePlatform {
  readonly platform: string;
  readonly arch: string;
  readonly musl: boolean;
}

/** The optional dependency of the main package that carries the binary for `host`, as the main package's own `optionalDependencies` name them (`@anthropic-ai/claude-code-linux-x64-musl` and kin). */
export function binaryPackageName(host: ClaudeCodePlatform): string {
  return `${CLAUDE_CODE_PACKAGE}-${host.platform}-${host.arch}${host.musl ? "-musl" : ""}`;
}

/** The registry document for one version of a package: the scope's slash is encoded, as the registry's own URLs encode it. */
export function registryVersionUrl(registry: string, packageName: string, version: string): string {
  return `${registry}/${packageName.replace("/", "%2f")}/${version}`;
}

/** The registry document listing every version of a package. */
export function registryPackageUrl(registry: string, packageName: string): string {
  return `${registry}/${packageName.replace("/", "%2f")}`;
}

/** What a registry version document says about its tarball: where it is and the subresource integrity string it must match. */
export interface RegistryTarball {
  readonly tarball: string;
  readonly integrity: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the tarball facts from a registry version document, failing on one that lacks them. */
export function parseRegistryTarball(document: unknown): RegistryTarball {
  if (!isRecord(document) || !isRecord(document.dist) || typeof document.dist.tarball !== "string" || typeof document.dist.integrity !== "string") {
    throw new Error("the registry's version document names no tarball and integrity");
  }
  return { tarball: document.dist.tarball, integrity: document.dist.integrity };
}

/** Reads the version names from a registry package document. */
export function parsePublishedVersions(document: unknown): readonly string[] {
  if (!isRecord(document) || !isRecord(document.versions)) {
    throw new Error("the registry's package document lists no versions");
  }
  return Object.keys(document.versions);
}

/** Whether `bytes` match a subresource integrity string, by its sha512 entry: the algorithm the registry publishes for every tarball. A string with no sha512 entry matches nothing. */
export function matchesIntegrity(integrity: string, bytes: Uint8Array): boolean {
  const expected = integrity
    .split(/\s+/)
    .filter((entry) => entry.startsWith("sha512-"))
    .map((entry) => entry.slice("sha512-".length));
  return expected.length > 0 && expected.includes(createHash("sha512").update(bytes).digest("base64"));
}

/** The source of `src/supervise/verifiedVersions.ts` with `versions` as the list: the one thing a candidate build or a recorded version changes. */
export function verifiedVersionsSource(current: string, versions: readonly string[]): string {
  const pattern = /(export const RC_SESSION_COMMAND_VERIFIED_VERSIONS: readonly string\[\] = )\[[^\]]*\];/;
  if (!pattern.test(current)) {
    throw new Error("src/supervise/verifiedVersions.ts no longer declares RC_SESSION_COMMAND_VERIFIED_VERSIONS as one array literal");
  }
  return current.replace(pattern, `$1${JSON.stringify(versions).replaceAll(",", ", ")};`);
}

/** The opening of the document's supported versions section, which names every verified version: the sentence `rcSessionCommands.repo.test.ts` checks against the list. */
const DOCUMENT_VERSIONS = /(## Supported versions\n\nThe goal, compaction and turn verbs are verified on Claude Code )[^(\n]+( \()/u;

/** Names versions in prose: "a", "a and b", "a, b and c". */
function inProse(versions: readonly string[]): string {
  return versions.length <= 1 ? versions.join("") : `${versions.slice(0, -1).join(", ")} and ${String(versions.at(-1))}`;
}

/** `docs/rc-slash-commands.md` with its supported versions sentence naming `versions`. */
export function documentWithVersions(current: string, versions: readonly string[]): string {
  if (!DOCUMENT_VERSIONS.test(current)) {
    throw new Error("docs/rc-slash-commands.md no longer opens its supported versions section with the sentence naming the verified versions");
  }
  return current.replace(DOCUMENT_VERSIONS, `$1${inProse(versions)}$2`);
}

/** The verified list with `added` in it, oldest first, each version once. */
export function withVersions(verified: readonly string[], added: readonly string[]): readonly string[] {
  return [...new Set([...verified, ...added])].sort(compareReleaseVersions);
}

/** The request ids in `frontdoor rc pending --json`'s answer, failing on an answer of another shape. */
export function pendingRequestIds(answer: unknown): readonly string[] {
  if (!isRecord(answer) || !Array.isArray(answer.pending)) {
    throw new Error(`frontdoor rc pending answered no pending list: ${JSON.stringify(answer)}`);
  }
  return answer.pending.map((request: unknown) => {
    if (!isRecord(request) || typeof request.requestId !== "string") {
      throw new Error(`a pending request names no request id: ${JSON.stringify(request)}`);
    }
    return request.requestId;
  });
}

/** The goal conditions the checks set: the second replaces the first, and the third is what a peer's `/goal` names, which must never be set. */
export const FIRST_CONDITION = "the lab's first check holds";
export const SECOND_CONDITION = "the lab's second check holds";
export const PEER_CONDITION = "a peer's goal that must not be set";
/** The text of the person's turn the checks put into the session. */
export const TURN_TEXT = "the lab's turn check";
/** The instructions the second compaction carries. */
export const COMPACT_INSTRUCTIONS = "keep the lab's checks";

/** One step of a route's checks: the `frontdoor rc` arguments after the session (`--session <id>` is added), and what its answer must be. `expect` answers the difference in words, or undefined when the answer is right. A step with `peer` set is a `send`, whose answer is not judged, and the step after it is. */
export interface LabCheck {
  readonly name: string;
  readonly args: readonly string[];
  readonly expect?: (answer: unknown, route: LabRoute) => string | undefined;
}

/** The difference between an answer's field and what it should be, or undefined when they agree. */
function field(answer: unknown, name: string, expected: unknown): string | undefined {
  if (!isRecord(answer)) {
    return `the answer is not an object: ${JSON.stringify(answer)}`;
  }
  const actual = answer[name];
  return JSON.stringify(actual) === JSON.stringify(expected) ? undefined : `${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

/** The first difference among several, or undefined when none differs. */
function first(...differences: readonly (string | undefined)[]): string | undefined {
  return differences.find((difference) => difference !== undefined);
}

/** The answer's goal condition, or the difference when it has no goal of that shape. */
function goalCondition(answer: unknown, expected: string | null): string | undefined {
  if (!isRecord(answer)) {
    return `the answer is not an object: ${JSON.stringify(answer)}`;
  }
  const goal = answer.goal;
  const actual = isRecord(goal) ? goal.condition : goal;
  return actual === expected ? undefined : `goal is ${JSON.stringify(goal)}, expected ${expected === null ? "none" : `the condition ${JSON.stringify(expected)}`}`;
}

/**
 * The checks the manual procedure in `docs/rc-slash-commands.md` ran on every route, in order: a person's turn, the goal read with none set, set, read back, replaced and cleared, a compaction with and without instructions, and a peer's `/goal` through `send` that leaves no goal set. Every answer must name the route the lab brought the session up on, a turn must answer the uuid of the user entry it recorded, and a compaction on the self-hosted route must end on a manual boundary.
 */
export const LAB_CHECKS: readonly LabCheck[] = [
  { name: "turn", args: ["turn", "--text", TURN_TEXT], expect: (answer, route) => first(field(answer, "route", route), isRecord(answer) && typeof answer.uuid === "string" && answer.uuid !== "" ? undefined : `uuid is ${JSON.stringify(isRecord(answer) ? answer.uuid : answer)}, expected the recorded user entry's`) },
  { name: "goal get, none set", args: ["goal", "get"], expect: (answer, route) => first(field(answer, "route", route), goalCondition(answer, null)) },
  { name: "goal set", args: ["goal", "set", "--condition", FIRST_CONDITION], expect: (answer, route) => first(field(answer, "route", route), field(answer, "condition", FIRST_CONDITION), field(answer, "superseded", null)) },
  { name: "goal get, set", args: ["goal", "get"], expect: (answer, route) => first(field(answer, "route", route), goalCondition(answer, FIRST_CONDITION)) },
  { name: "goal set, replacing", args: ["goal", "set", "--condition", SECOND_CONDITION], expect: (answer, route) => first(field(answer, "route", route), field(answer, "condition", SECOND_CONDITION), field(answer, "superseded", FIRST_CONDITION)) },
  { name: "goal clear", args: ["goal", "clear"], expect: (answer, route) => first(field(answer, "route", route), field(answer, "cleared", SECOND_CONDITION)) },
  { name: "compact", args: ["compact"], expect: (answer, route) => first(field(answer, "route", route), route === "self-hosted" ? field(answer, "trigger", "manual") : undefined) },
  { name: "compact with instructions", args: ["compact", "--instructions", COMPACT_INSTRUCTIONS], expect: (answer, route) => first(field(answer, "route", route), route === "self-hosted" ? field(answer, "trigger", "manual") : undefined) },
  { name: "a peer's /goal through send", args: ["send", "--text", `/goal ${PEER_CONDITION}`] },
  { name: "goal get, after a peer's /goal", args: ["goal", "get"], expect: (answer, route) => first(field(answer, "route", route), goalCondition(answer, null)) },
];

/** One check's outcome on one route: `difference` is undefined when it passed. */
export interface LabCheckResult {
  readonly route: LabRoute;
  readonly name: string;
  readonly difference?: string;
}

/** The report a run prints: one line per check, the differing ones named with what differed, and the verdict last. */
export function formatReport(version: string, results: readonly LabCheckResult[]): readonly string[] {
  const failed = results.filter((result) => result.difference !== undefined);
  return [
    ...results.map((result) => (result.difference === undefined ? `pass    ${result.route}: ${result.name}` : `DIFFERS ${result.route}: ${result.name}: ${result.difference}`)),
    failed.length === 0 ? `Claude Code ${version}: every check passed` : `Claude Code ${version}: ${String(failed.length)} of ${String(results.length)} checks differed`,
  ];
}
