import fs from "node:fs";
import path from "node:path";

import { UsageError } from "./cliError";
import type { LayoutPaths } from "./paths";

/** Owner-only permissions: the token file readable and writable by the user alone, its directory traversable by the user alone. */
export const TOKEN_FILE_MODE = 0o600;
export const TOKEN_DIR_MODE = 0o700;

/** The shape of a `claude setup-token` token: a versioned `sk-ant-oat` prefix and a URL-safe body. Anything else pasted by mistake (an API key, an error message, a whole terminal screen) is refused before it reaches disk. */
const OAUTH_TOKEN_RE = /^sk-ant-oat\d+-[A-Za-z0-9_-]+$/;

/** The directory holding one stored token file per identity. Outside every identity's farm, so no sharing rule can ever link or sync it. */
function identityTokenDir(paths: LayoutPaths): string {
  return path.join(paths.root, "credentials");
}

/** Where the stored `claude setup-token` token of the identity stored under id `identityId` lives. It is filed by id, which a rename keeps, so a credential `file` source naming it stays valid. */
export function identityTokenPath(paths: LayoutPaths, identityId: string): string {
  return path.join(identityTokenDir(paths), `${identityId}.token`);
}

/**
 * Validates `raw` as a `claude setup-token` token and writes it for the identity stored under id `identityId` at mode 0600 inside a 0700 directory, returning the file's path. Surrounding whitespace is trimmed (a pasted token usually ends in a newline). Throws `UsageError`, never echoing the rejected text, when it is not shaped like a token.
 */
export function storeIdentityToken(paths: LayoutPaths, identityId: string, raw: string): string {
  const token = raw.trim();
  if (!OAUTH_TOKEN_RE.test(token)) {
    throw new UsageError("That is not a claude setup-token token (expected it to start with sk-ant-oat). Run `claude setup-token` and pass its token on standard input.");
  }
  const dir = identityTokenDir(paths);
  fs.mkdirSync(dir, { recursive: true, mode: TOKEN_DIR_MODE });
  fs.chmodSync(dir, TOKEN_DIR_MODE);
  const target = identityTokenPath(paths, identityId);
  const temp = path.join(dir, `.${identityId}.${String(process.pid)}.tmp`);
  fs.writeFileSync(temp, `${token}\n`, { mode: TOKEN_FILE_MODE });
  fs.renameSync(temp, target);
  return target;
}
