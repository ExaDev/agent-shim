import { RC_SESSION_COMMAND_VERIFIED_VERSIONS, parseReleaseVersion, type ReleaseVersion } from "./verifiedVersions";

/**
 * One version of each class the gate tells apart (`claudeCodeVersionGate`), derived from the verified list so the tests follow it rather than restate it.
 */

/** The parts of every verified version, failing loudly on one that does not parse, as the gate itself does. */
const listed: readonly ReleaseVersion[] = RC_SESSION_COMMAND_VERIFIED_VERSIONS.map((version) => {
  const parsed = parseReleaseVersion(version);
  if (parsed === undefined) {
    throw new Error(`the verified list holds ${version}, which is not a release version`);
  }
  return parsed;
});

/** The first verified version, failing loudly on an empty list. */
function firstVerified(): string {
  const [first] = RC_SESSION_COMMAND_VERIFIED_VERSIONS;
  if (first === undefined) {
    throw new Error("the verified list is empty");
  }
  return first;
}

/** A version on the verified list. */
export const VERIFIED_VERSION = firstVerified();

const firstParts = parseReleaseVersion(VERIFIED_VERSION);
if (firstParts === undefined) {
  throw new Error(`the verified list holds ${VERIFIED_VERSION}, which is not a release version`);
}

/** A patch release of the first verified version's minor that is not itself on the list: one past the highest listed patch of that minor. */
export const UNVERIFIED_PATCH_VERSION = `${String(firstParts.major)}.${String(firstParts.minor)}.${String(Math.max(...listed.filter((version) => version.major === firstParts.major && version.minor === firstParts.minor).map((version) => version.patch)) + 1)}`;

/** A version whose minor no verified version has: one past the highest listed minor of the first version's major. */
export const UNVERIFIED_MINOR_VERSION = `${String(firstParts.major)}.${String(Math.max(...listed.filter((version) => version.major === firstParts.major).map((version) => version.minor)) + 1)}.0`;
