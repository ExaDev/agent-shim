import { vcsStatusOf } from "../../vcs/status";
import type { RenderContext } from "../context";

/** The ahead marker's colour: critical from `git.pushCriticalAt`, warning from `git.pushWarnAt`, else the branch's own; a threshold of 0 is off. */
function aheadText(ahead: number, { settings, palette }: RenderContext): string {
  const text = `↑${String(ahead)}`;
  const { pushCriticalAt, pushWarnAt } = settings.git;
  if (pushCriticalAt > 0 && ahead >= pushCriticalAt) {
    return palette.paint("critical", text);
  }
  return pushWarnAt > 0 && ahead >= pushWarnAt ? palette.paint("warning", text) : palette.paint("gitBranch", text);
}

/**
 * The working directory's version control: `git:(main* ↑2 ↓1 [+10 -3])`, or `jj:(bookmark* !conflict)` in a Jujutsu repository. Each marker is drawn only when its setting asks for it, and ahead, behind and line counts are git's alone. Undefined when there is no repository to read. The segment is painted in `colours.git` by the registry, which colours the wrapper text, so the closing bracket and every inner part paint themselves.
 */
export function vcsSegment(context: RenderContext): string | undefined {
  const status = vcsStatusOf(context);
  if (status === undefined) {
    return undefined;
  }
  const { settings, palette } = context;
  const isGit = status.kind === "git";
  const showDirty = isGit ? settings.git.showDirty : settings.jj.showDirty;
  const inner = [palette.paint("gitBranch", status.branch + (showDirty && status.dirty ? "*" : ""))];
  if (isGit && settings.git.showAheadBehind) {
    if (status.ahead > 0) {
      inner.push(aheadText(status.ahead, context));
    }
    if (status.behind > 0) {
      inner.push(palette.paint("gitBranch", `↓${String(status.behind)}`));
    }
  }
  if (isGit && settings.git.showLineDiff && status.lineDiff !== undefined) {
    const { added, deleted } = status.lineDiff;
    const counts = [...(added > 0 ? [palette.paint("context", `+${String(added)}`)] : []), ...(deleted > 0 ? [palette.paint("critical", `-${String(deleted)}`)] : [])];
    if (counts.length > 0) {
      inner.push(`[${counts.join(" ")}]`);
    }
  }
  if (!isGit && settings.jj.showConflicts && status.conflict) {
    inner.push(palette.paint("critical", context.t("vcs.conflict")));
  }
  return `${status.kind}:(${inner.join(" ")}${palette.paint("git", ")")}`;
}
