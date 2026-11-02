import path from "node:path";

import type { CredentialSource } from "./config/schema";

/** One path that moves: where it is, and where it goes. */
export interface MovedPlace {
  readonly from: string;
  readonly to: string;
}

/** Where the renamed identity's files go, as the credential `file` sources that name them must follow. */
export interface MovedPaths {
  /** The stored token file: where it is and where it goes, spelled directly and, when a directory above it is a symlink, through the real path of the directory that holds it, since a source can name it either way. */
  readonly tokens: readonly MovedPlace[];
  /** The identity's directory, spelled the same ways. */
  readonly directories: readonly MovedPlace[];
  /** The Keychain service names Claude Code files the login of each directory under: a credential `keychain` source naming the old one names the login this rename moves. */
  readonly fromService: string;
  readonly toService: string;
  readonly home: string;
}

/** Expands a leading `~/` as the credential resolver does. */
function expandHome(filePath: string, home: string): string {
  return filePath.startsWith("~/") ? path.join(home, filePath.slice(1)) : filePath;
}

/** `absolute` written the way `original` was: with a leading `~` when it was and the new path is still under the home directory, so a source that was portable between machines stays so. */
function spelledLike(original: string, absolute: string, home: string): string {
  return original.startsWith("~/") && absolute.startsWith(`${home}${path.sep}`) ? `~${absolute.slice(home.length)}` : absolute;
}

/**
 * A credential source after the rename. A `file` source that names the identity's stored token file follows the file to its new name, and one that points inside the identity's directory follows the directory; any other path is the person's own and stays where it points. A `keychain` source naming the Keychain service of the old directory's login follows the login to its new service. Sources of every other kind name things the rename does not move and are untouched.
 */
function repointedSource(source: CredentialSource, moved: MovedPaths): CredentialSource {
  if ("keychain" in source) {
    // The login is copied to the new service and the old item deleted last, so a source still naming the old service would name an item that is gone.
    return source.keychain.service === moved.fromService ? { ...source, keychain: { ...source.keychain, service: moved.toService } } : source;
  }
  if (!("file" in source)) {
    return source;
  }
  const file = expandHome(source.file, moved.home);
  for (const { from, to } of moved.tokens) {
    if (file === from) {
      return { file: spelledLike(source.file, to, moved.home) };
    }
  }
  for (const { from, to } of moved.directories) {
    if (file === from || file.startsWith(`${from}${path.sep}`)) {
      return { file: spelledLike(source.file, `${to}${file.slice(from.length)}`, moved.home) };
    }
  }
  return source;
}

/**
 * `place` and, when it differs, the same place spelled through the real path of the directory that holds it: a state root reached through a symlink can be named by either. The place itself is not resolved, since when it is a symlink only the link moves and what it points at stays where it is.
 */
export function placesThroughRealParent(place: MovedPlace, realpath: (target: string) => string): readonly MovedPlace[] {
  const through = (target: string): string => path.join(realpath(path.dirname(target)), path.basename(target));
  const real = { from: through(place.from), to: through(place.to) };
  return real.from === place.from && real.to === place.to ? [place] : [place, real];
}

/** `target` as a person or a shell script could write it: in full, and when it is under the home directory also with a leading `~`, `$HOME` or `${HOME}`. */
function spellingsOf(target: string, home: string): readonly string[] {
  if (!target.startsWith(`${home}${path.sep}`)) {
    return [target];
  }
  const rest = target.slice(home.length);
  return [target, `~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`];
}

/** `sources` with each one re-pointed, or undefined when none of them names anything that moved. */
export function repointedSources(sources: readonly CredentialSource[], moved: MovedPaths): CredentialSource[] | undefined {
  const next = sources.map((source) => repointedSource(source, moved));
  return JSON.stringify(next) === JSON.stringify(sources) ? undefined : next;
}

/** Whether `text` holds `target` as a whole path: not as the start of a longer name, so the directory of `work` is not found in that of `work-two`. */
function namesPath(text: string, target: string): boolean {
  for (let at = text.indexOf(target); at !== -1; at = text.indexOf(target, at + 1)) {
    if (!/[A-Za-z0-9._@-]/u.test(text.charAt(at + target.length))) {
      return true;
    }
  }
  return false;
}

/** Whether `text`, a file that could not be read or the arguments of a source, names something the rename moves: the token file or directory in any spelling a source could take, or the Keychain service of the login, which is deleted once it has been copied. A service is a name ending in a hash, so it is told from a longer one by the same boundary as a path. */
export function namesMovedPath(text: string, moved: MovedPaths): boolean {
  return namesPath(text, moved.fromService) || [...moved.tokens, ...moved.directories].some(({ from }) => spellingsOf(from, moved.home).some((spelling) => namesPath(text, spelling)));
}
