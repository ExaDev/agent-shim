/** Lines added and removed, as `git diff --numstat` counts them. */
export interface LineDiff {
  readonly added: number;
  readonly deleted: number;
}

/** A tracked file the working tree has changed, as the `gitFiles` row draws it. */
export interface ChangedFile {
  readonly basename: string;
  readonly kind: "modified" | "added" | "deleted";
  /** The file's own lines added and removed, when they were asked for and counted. */
  readonly lines: LineDiff | undefined;
}

/** What the statusline knows of the working directory's version control: git's or Jujutsu's, never both. */
export interface VcsStatus {
  readonly kind: "git" | "jj";
  /** The branch (git) or first bookmark (Jujutsu), else a tag, `detached:<commit>` or the change id. */
  readonly branch: string;
  readonly dirty: boolean;
  /** Whether the working-copy commit has an unresolved conflict; always false for git, whose conflicts are files. */
  readonly conflict: boolean;
  /** Commits ahead of and behind the upstream; zero when there is none, and always zero for Jujutsu. */
  readonly ahead: number;
  readonly behind: number;
  /** The total lines changed against HEAD, when asked for and the tree is dirty. */
  readonly lineDiff: LineDiff | undefined;
  /** The changed tracked files, most recently modified first, and how many untracked files there are; when asked for. */
  readonly files: { readonly tracked: readonly ChangedFile[]; readonly untracked: number } | undefined;
}

/** What a read of git must bring back, so that a refresh runs only the commands the settings need. */
export interface GitQuery {
  /** Whether the working tree is read: its dirtiness, and the upstream's ahead and behind counts. Without it only the branch is read. */
  readonly workingTree: boolean;
  /** Whether the changed files are listed. */
  readonly files: boolean;
  /** Whether the lines changed are counted, in total and per file. */
  readonly lineDiff: boolean;
}
