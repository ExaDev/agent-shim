import os from "node:os";

import type { CatalogueKeeperDeps } from "../catalogueKeeper";
import { savedCatalogueFingerprint } from "../codex/catalogueCredential";
import type { LayoutPaths } from "../paths";
import { realFsPort } from "../realPorts";
import { StoredCatalogue, TolerantReader, raiseUnreadableCatalogue } from "../storedCatalogue";

/**
 * What the catalogue keeper reads of the stored state: a provider's catalogue file (a codex provider's in the directory of the door's own generation), the file holding the digest of the settings an `http` provider's catalogue was fetched under, and the login a Codex provider's catalogue is bound to (the door's own environment decides which). A file that exists and cannot be read raises an `UnreadableCatalogueError` (the fault, never the path), which the keeper records against that one provider.
 */
export function keeperCatalogueReaders(paths: LayoutPaths, supervisorPid: number, generation: string, env: Readonly<Record<string, string | undefined>> = process.env, home: string = os.homedir()): Pick<CatalogueKeeperDeps, "readCache" | "readSettings" | "credentialFingerprint"> {
  const reader = new TolerantReader((file) => realFsPort.readFileUtf8(file), raiseUnreadableCatalogue);
  const stored = new StoredCatalogue(paths, reader);
  return {
    readCache: (name, provider) => stored.cacheText(name, provider.kind === "codex" ? { pid: supervisorPid, generation } : undefined),
    readSettings: (name) => stored.digestText(name),
    credentialFingerprint: (provider) => (provider.kind === "codex" ? savedCatalogueFingerprint(provider, paths, env, home, reader) : undefined),
  };
}
