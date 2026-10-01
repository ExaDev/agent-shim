const GIT_SPEC_RE = /git\+[^@\s]+(?:@([^\s#]+))?/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

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
