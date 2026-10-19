import type { RenderContext } from "../elements/context";
import { workingDirectoryOf } from "../projectPath";
import { readGitStatus } from "./git";
import { isJjRepository, readJjStatus } from "./jj";
import type { GitQuery, VcsStatus } from "./types";

/** What one render has read, so that the vcs segment and the gitFiles row, which both need the status, cost one read between them: a render builds one context and hands it to every element. */
const READ = new WeakMap<RenderContext, VcsStatus | undefined>();

/** What git must be asked for under the settings: the working tree only when something drawn needs it, the changed files only for the row that lists them, and line counts for the total or for those files. */
function gitQueryOf({ settings }: RenderContext): GitQuery {
  const files = settings.layout.rows.includes("gitFiles");
  const lineDiff = settings.git.showLineDiff || files;
  return { workingTree: settings.git.showDirty || settings.git.showAheadBehind || files || lineDiff, files, lineDiff };
}

/** The version control status of the session's working directory under the settings: Jujutsu's when it is enabled and the directory is in a Jujutsu repository (and jj answers), else git's when it is enabled. Never both, even in a repository that holds both. Undefined when the client names no directory, neither is enabled, or there is no repository. */
export function vcsStatusOf(context: RenderContext): VcsStatus | undefined {
  if (READ.has(context)) {
    return READ.get(context);
  }
  const { settings, ports, payload } = context;
  const cwd = workingDirectoryOf(payload);
  let status: VcsStatus | undefined;
  if (cwd !== undefined) {
    if (settings.jj.enabled && isJjRepository(ports, cwd)) {
      status = readJjStatus(ports, cwd);
    }
    if (status === undefined && settings.git.enabled) {
      status = readGitStatus(ports, cwd, gitQueryOf(context));
    }
  }
  READ.set(context, status);
  return status;
}
