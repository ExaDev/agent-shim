import fs from "node:fs";
import os from "node:os";
import type { FrontDoorPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { listProviders } from "../providersStore";
import { CATALOGUE_REFRESH_TIMEOUT_MS, CATALOGUE_RETRY_MS, catalogueCachePath, isCatalogueStale, parseCatalogueCache } from "../providerCatalogue";
import { savedCatalogueFingerprint } from "../codex/catalogueCredential";
import { realFarmFs, realIsFrontDoorSupervisor, realIsProcessRunning, realSleepSync, type DaemonSpawner } from "../realPorts";
import { appendDoorLog } from "./doorLog";
import type { RequestedReplacementReason } from "./replacement";
import { ensureFrontDoor, FRONTDOOR_LAUNCHER_POLL_MS, restartFrontDoor, type EnsureFrontDoorPorts, type RestartFrontDoorResult } from "./ensure";
import { readCatalogueStatus, readFrontDoorCodexRecord, readFrontDoorState, removeFrontDoorSession } from "./state";
import { probeFrontDoorSync, requestCatalogueRefreshSync } from "./probe";
import { isDeclaredFrontDoor, isFrontDoorSupervisorPid } from "./selfIdentity";
import { resolveTrustBundle, type TrustBundleFs } from "./trust";


/** The real file effects for `resolveTrustBundle`. The bundle is public certificate material, so the atomic write's owner-only mode costs nothing: only this user's children read it. */
export const realTrustBundleFs: TrustBundleFs = {
  readFileUtf8: (file) => fs.readFileSync(file, "utf8"),
  exists: (file) => fs.existsSync(file),
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  writeFileAtomic: (file, contents) => {
    realFarmFs.writeFilePrivate(file, contents);
  },
};

/** The real effects `ensureFrontDoor` runs against, shared by a launch and by a restart so both authenticate and replace a door the same way. */
function realEnsurePorts(paths: LayoutPaths, spawnDaemon: DaemonSpawner): EnsureFrontDoorPorts {
  return {
    fs: realFarmFs,
    // The door plans launches of its own (the usage probe, the window opener, jobs), and asked whether the supervisor the state file names is running, the answer for itself is known: a synchronous `ps` here would hold the loop that answers every session.
    isRunning: (pid) => isDeclaredFrontDoor(pid) || realIsProcessRunning(pid),
    now: () => Date.now(),
    sleep: realSleepSync,
    spawnSupervisor: (layout) => spawnDaemon(layout, "__frontdoor-supervisor", layout.frontdoorLogPath),
    isFrontDoorSupervisor: (pid) => isFrontDoorSupervisorPid(pid, realIsFrontDoorSupervisor),
    recordReplacement: (line) => {
      appendDoorLog(paths, line);
    },
    stopSupervisor: (pid) => {
      process.kill(pid, "SIGTERM");
    },
    killSupervisor: (pid) => {
      process.kill(pid, "SIGKILL");
    },
    // Windows has no user signals (Node refuses to send one), so a replacement there keeps the stop-and-start path.
    ...(process.platform === "win32"
      ? {}
      : {
          requestHandover: (pid: number) => {
            process.kill(pid, "SIGUSR2");
          },
        }),
    // Read fresh for each probe: a replacement supervisor may have regenerated an unparseable CA, and the probe must trust exactly what the serving door's leaf chains to.
    verifyListener: (port) => probeFrontDoorSync(port, fs.readFileSync(paths.frontdoorCaCertFile, "utf8")),
  };
}

/** `restartFrontDoor` over the real effects, spawning the replacement through `spawnDaemon`. */
export function realRestartFrontDoor(paths: LayoutPaths, spawnDaemon: DaemonSpawner, reason: RequestedReplacementReason): RestartFrontDoorResult {
  return restartFrontDoor({ paths, pid: process.pid, reason, ports: realEnsurePorts(paths, spawnDaemon) });
}

/** The real `FrontDoorPort` for one launch: `ensure` runs the lock-and-poll coordination, authenticates the listener and registers this launcher; `release` removes its registration. */
export function realFrontDoorPort(paths: LayoutPaths, spawnDaemon: DaemonSpawner): FrontDoorPort {
  return {
    waitForCatalogues: (supervisorPid) => {
      const deadline = Date.now() + CATALOGUE_REFRESH_TIMEOUT_MS;
      let requested = false;
      const warnings = new Set<string>();
      while (!isDeclaredFrontDoor(supervisorPid) && listProviders(paths).map(({ name, provider }) => {
        const owner = readFrontDoorCodexRecord(realFarmFs, paths.frontdoorDir, supervisorPid);
        const published = owner === undefined ? undefined : readCatalogueStatus(realFarmFs, paths, supervisorPid, owner.generation, name);
        if (provider.kind !== "codex" && published?.status === "failed" && published.recordedAt !== undefined && published.recordedAt <= Date.now() && Date.now() - published.recordedAt < CATALOGUE_RETRY_MS) {
          warnings.add(`Catalogue refresh failed for ${name}`);
          return false;
        }
        if (provider.kind === "codex") {
          if (owner === undefined) return true;
          const cache = parseCatalogueCache(realFarmFs.readFileUtf8(catalogueCachePath(paths, name, supervisorPid, owner.generation)));
          let fingerprint: string | undefined;
          try {
            fingerprint = savedCatalogueFingerprint(provider, paths, { ...process.env, CODEX_HOME: owner.codexHome }, os.homedir(), realFarmFs.readFileUtf8);
          } catch (error) {
            warnings.add(`Cannot read catalogue credentials for ${name}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          }
          const outcome = readCatalogueStatus(realFarmFs, paths, supervisorPid, owner.generation, name);
          if (outcome?.status === "failed" && outcome.fingerprint === fingerprint && outcome.recordedAt !== undefined && outcome.recordedAt <= Date.now() && Date.now() - outcome.recordedAt < CATALOGUE_RETRY_MS) {
            warnings.add(`Catalogue refresh failed for ${name}`);
            return false;
          }
          return cache === undefined || isCatalogueStale(cache, Date.now()) || cache.supervisorPid !== supervisorPid || fingerprint === undefined || cache.credentialFingerprint !== fingerprint;
        }
        if ((provider.kind !== undefined && provider.kind !== "http") || provider.catalogue === undefined) return false;
        const cache = parseCatalogueCache(realFarmFs.readFileUtf8(catalogueCachePath(paths, name)));
        return cache === undefined || isCatalogueStale(cache, Date.now());
      }).some(Boolean)) {
        if (Date.now() >= deadline) return [...warnings, "Timed out waiting for provider catalogues"].join("; ");
        if (!requested) {
          const door = readFrontDoorState(realFarmFs, paths.frontdoorStateFile);
          const token = realFarmFs.readFileUtf8(paths.frontdoorControlTokenFile)?.trim();
          if (door?.supervisorPid !== supervisorPid || door.port === undefined || token === undefined || token === "") return "The serving front door's catalogue control material is unavailable";
          const certificate = realFarmFs.readFileUtf8(paths.frontdoorCaCertFile);
          if (certificate === undefined) return "The serving front door's catalogue certificate is unavailable";
          const result = requestCatalogueRefreshSync(door.port, certificate, token);
          if (!result.ok) return `The front door refused a catalogue refresh: ${result.reason}`;
          requested = true;
        }
        realSleepSync(FRONTDOOR_LAUNCHER_POLL_MS);
        if (readFrontDoorState(realFarmFs, paths.frontdoorStateFile)?.supervisorPid !== supervisorPid) return "The front door changed while waiting for provider catalogues";
        warnings.clear();
      }
      return warnings.size === 0 ? undefined : [...warnings].join("; ");
    },
    ensure: (inheritedExtraCaCerts, session) => {
      const up = ensureFrontDoor({ paths, launcherPid: process.pid, ports: realEnsurePorts(paths, spawnDaemon), ...(session === undefined ? {} : { session }) });
      const trust = resolveTrustBundle({ caCertFile: paths.frontdoorCaCertFile, bundlesDir: paths.frontdoorCaBundlesDir, variable: "NODE_EXTRA_CA_CERTS", inherited: inheritedExtraCaCerts, fs: realTrustBundleFs });
      return {
        port: up.port,
        connectPort: up.connectPort,
        supervisorPid: up.supervisorPid,
        trustBundlePath: trust.path,
        ...(trust.warning === undefined ? {} : { trustWarning: trust.warning }),
        sessionToken: up.token,
      };
    },
    release: () => {
      removeFrontDoorSession(realFarmFs, paths.frontdoorSessionsDir, process.pid);
    },
  };
}
