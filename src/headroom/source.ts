import { z } from "zod";

const GIT_SPEC_RE = /git\+[^@\s]+(?:@([^\s#]+))?/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/** The shape of `direct_url.json` that `uv` and `pip` record in an install's dist-info (PEP 610): the resolved commit sits under `vcs_info`. */
const DirectUrlSchema = z.object({ vcs_info: z.object({ commit_id: z.string() }) });

/**
 * Whether an install spec resolves through a git ref that can move underneath it. A full commit SHA never moves; a branch name, a tag a maintainer can re-point, or no ref at all (the remote's default branch) can, and a rebased, renamed or deleted branch changes or breaks every fresh install. A registry requirement is not a git source.
 */
export function isMovingGitSource(spec: string): boolean {
  const match = GIT_SPEC_RE.exec(spec);
  if (match === null) {
    return false;
  }
  const ref = match[1];
  return ref === undefined || !COMMIT_SHA_RE.test(ref);
}

/** The full commit SHA an install spec pins, lowercased, or undefined when the spec is a registry requirement or follows a moving ref. */
export function pinnedGitCommit(spec: string): string | undefined {
  const ref = GIT_SPEC_RE.exec(spec)?.[1];
  return ref !== undefined && COMMIT_SHA_RE.test(ref) ? ref.toLowerCase() : undefined;
}

/** The commit an install was built from, read from the text of its `direct_url.json`, or undefined when the file records no VCS commit (a registry install) or is not valid JSON. */
export function parseInstalledCommit(directUrlJson: string): string | undefined {
  try {
    const parsed = DirectUrlSchema.safeParse(JSON.parse(directUrlJson));
    return parsed.success ? parsed.data.vcs_info.commit_id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
