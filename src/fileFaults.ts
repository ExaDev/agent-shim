/**
 * The read failures that say something about a file as it stands, which stay true until the file or a directory on its path changes: nothing there (`ENOENT`), a path through a file (`ENOTDIR`), a directory in its place (`EISDIR`), a symlink loop (`ELOOP`), a name too long (`ENAMETOOLONG`), and no permission (`EACCES`, and `EPERM`, which macOS gives for a file a flag or its privacy controls deny, a property of the file too). Every other code is a failure of the moment (`EMFILE`, `ENFILE`, `EAGAIN`, `EIO`, `EBUSY`, `EINTR` and any code not listed here): the same read may succeed at once. Every reader of local files classifies a failure through this one set.
 */
const FILE_FAULT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "ENAMETOOLONG", "EACCES", "EPERM"]);

/** The `code` of a system error, or undefined for anything else. */
export function systemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** The code of `error` when it is a read failure that is the file's own (see `FILE_FAULT_CODES`), else undefined: a failure of the moment, or no system error at all. */
export function fileFaultCodeOf(error: unknown): string | undefined {
  const code = systemErrorCode(error);
  return code !== undefined && FILE_FAULT_CODES.has(code) ? code : undefined;
}
