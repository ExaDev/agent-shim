import path from "node:path";
import os from "node:os";

import { spawnSyncBlocking } from "./blockingSpawn";
import { createCodexRoutePorts } from "./codex/commands";
import { resolveCodexConfig } from "./codex/translate";
import { refreshProviderCatalogue } from "./catalogueRefresh";
import { readFrontDoorCodexRecord, readFrontDoorState } from "./frontdoor/state";
import { writeJsonAtomic } from "./config/store";
import { resolveCredential } from "./credential";
import { catalogueBindingPath, catalogueCachePath, type CatalogueCache, type CatalogueFetch } from "./providerCatalogue";
import type { LayoutPaths } from "./paths";
import { readProvider } from "./providersStore";
import { realCredentialPort, realFarmFs, realFsPort } from "./realPorts";

/** One real GET: the status and the parsed JSON body, which is `undefined` when the body is not JSON. */
export const realCatalogueFetch: CatalogueFetch = async (url, headers, timeoutMs) => {
  const response = await fetch(url, { headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    return { status: response.status, body };
  } catch {
    return { status: response.status, body: undefined };
  }
};

/** Fetches and stores `name`'s catalogue for real: its provider file, its own credential (through the real credential port and its cache), the network and an atomic write. Shared by the door's refresh child and `agent-shim provider models --refresh`. */
export async function refreshCatalogueForReal(paths: LayoutPaths, name: string, env: Readonly<Record<string, string | undefined>>, ...owner: readonly [] | readonly [supervisorPid: number, generation: string]): Promise<CatalogueCache> {
  const [supervisorPid, generation] = owner;
  const provider = readProvider(paths, name);
  const login = provider?.kind === "codex" ? resolveCodexConfig(provider.codex).login : undefined;
  const configuredHome = env.CODEX_HOME;
  const home = configuredHome === undefined || configuredHome === "" ? path.join(os.homedir(), ".codex") : configuredHome;
  const source = login === undefined ? undefined : login === "chatgpt-sign-in" ? paths.chatgptSignInFile : path.resolve(home, "auth.json");
  let revision = source === undefined ? undefined : realFsPort.fileRevision?.(source);
  const codexAuth = login === undefined ? undefined : createCodexRoutePorts((line) => { console.error(line); }, paths.chatgptSignInFile, { env }).upstreams[login].auth;
  let firstRead = true;
  const trackedAuth = codexAuth === undefined ? undefined : {
    current: async () => {
      const credential = await codexAuth.current();
      if (firstRead) {
        revision = source === undefined ? undefined : realFsPort.fileRevision?.(source);
        firstRead = false;
      }
      return credential;
    },
    refresh: async (rejected: string) => {
      const credential = await codexAuth.refresh(rejected);
      revision = source === undefined ? undefined : realFsPort.fileRevision?.(source);
      return credential;
    },
  };
  const versionResult = login === "codex-cli" ? spawnSyncBlocking("a Codex version check", "codex", ["--version"], { encoding: "utf8", env }) : undefined;
  const codexVersion = versionResult?.status === 0 ? /^codex-cli\s+(\S+)/.exec(versionResult.stdout)?.[1] : undefined;
  const assertOwner = (): void => {
    if (supervisorPid !== undefined && readFrontDoorState(realFarmFs, paths.frontdoorStateFile)?.supervisorPid !== supervisorPid) throw new Error("front door changed during catalogue refresh");
    if (supervisorPid !== undefined && readFrontDoorCodexRecord(realFarmFs, paths.frontdoorDir, supervisorPid)?.generation !== generation) throw new Error("front door changed during catalogue refresh");
  };
  return await refreshProviderCatalogue(name, {
    paths,
    readProvider: () => provider,
    resolveCredential: (providerName, definition) => resolveCredential({ credential: definition.credential, env, port: realCredentialPort, subject: `provider ${providerName}` }),
    fetch: realCatalogueFetch,
    ...(trackedAuth === undefined ? {} : { codexAuth: trackedAuth }),
    ...(codexVersion === undefined ? {} : { codexVersion }),
    now: () => Date.now(),
    write: (filePath, cache) => {
      assertOwner();
      if (source !== undefined && (revision === undefined || realFsPort.fileRevision?.(source) !== revision)) throw new Error("Codex login changed during catalogue refresh");
      const destination = supervisorPid === undefined || login === undefined ? filePath : catalogueCachePath(paths, name, supervisorPid, generation);
      writeJsonAtomic(destination, supervisorPid === undefined || login === undefined ? cache : { ...cache, supervisorPid });
    },
    writeBinding: (providerName, fingerprint) => {
      assertOwner();
      if (source === undefined || revision === undefined) throw new Error("Codex login revision is unavailable");
      if (realFsPort.fileRevision?.(source) !== revision) throw new Error("Codex login changed during catalogue refresh");
      const destination = catalogueBindingPath(paths, providerName, supervisorPid, generation);
      realFarmFs.mkdirp(path.dirname(destination));
      realFarmFs.writeFilePrivate(destination, JSON.stringify({ fingerprint, source, revision }));
    },
  });
}
