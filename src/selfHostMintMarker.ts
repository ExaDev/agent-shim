import path from "node:path";

import { readJsonObject } from "./jsonObjectFile";
import type { FarmFs } from "./launcher/ports";

/**
 * The file the mint leaves in the identity's directory to say it minted a self-hosted login there. On macOS Claude Code reads its login from the Keychain item filed for the directory and falls back to `.credentials.json` when there is none (its secure storage in 2.1.319), so the minted file is what a fresh identity signs in with; any credential write the CLI makes goes to the Keychain first and then deletes the file. The marker says only that a mint happened, never what a Keychain item holds (a real `/login` after the mint writes an item too), so nothing is ever deleted on its strength: `identity remove` uses it to name a leftover item and the command that deletes it.
 */
export const RC_SELF_HOST_MINT_MARKER = ".agent-shim-selfhost-mint";

/** Whether the mint wrote into the identity directory `identityDir`: its marker (`RC_SELF_HOST_MINT_MARKER`) is there and parses as the mint writes it, a JSON object naming when it minted. A file of any other content is not a mint's. */
export function isSelfHostMinted(fs: Pick<FarmFs, "readFileUtf8">, identityDir: string): boolean {
  const marker = readJsonObject(fs, path.join(identityDir, RC_SELF_HOST_MINT_MARKER));
  return typeof marker?.mintedAt === "string" && !Number.isNaN(Date.parse(marker.mintedAt));
}
