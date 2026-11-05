/** `value` as one POSIX shell word that the shell takes literally: in single quotes, with each single quote inside it closed, escaped and reopened. Nothing about `value` needs to be safe to paste into a shell. */
export function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
