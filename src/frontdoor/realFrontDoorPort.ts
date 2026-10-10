import fs from "node:fs";
import type { FrontDoorPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realIsProcessRunning, realSleepSync, type DaemonSpawner } from "../realPorts";
import { ensureFrontDoor, restartFrontDoor, type EnsureFrontDoorPorts, type RestartFrontDoorResult } from "./ensure";
import { removeFrontDoorSession } from "./state";
import { probeFrontDoorSync } from "./probe";
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
    isRunning: realIsProcessRunning,
    now: () => Date.now(),
    sleep: realSleepSync,
    spawnSupervisor: (layout) => spawnDaemon(layout, "__frontdoor-supervisor", layout.frontdoorLogPath),
    stopSupervisor: (pid) => {
      process.kill(pid, "SIGTERM");
    },
    // Read fresh for each probe: a replacement supervisor may have regenerated an unparseable CA, and the probe must trust exactly what the serving door's leaf chains to.
    verifyListener: (port) => probeFrontDoorSync(port, fs.readFileSync(paths.frontdoorCaCertFile, "utf8")),
  };
}

/** `restartFrontDoor` over the real effects, spawning the replacement through `spawnDaemon`. */
export function realRestartFrontDoor(paths: LayoutPaths, spawnDaemon: DaemonSpawner): RestartFrontDoorResult {
  return restartFrontDoor({ paths, pid: process.pid, ports: realEnsurePorts(paths, spawnDaemon) });
}

/** The real `FrontDoorPort` for one launch: `ensure` runs the lock-and-poll coordination, authenticates the listener and registers this launcher; `release` removes its registration. */
export function realFrontDoorPort(paths: LayoutPaths, spawnDaemon: DaemonSpawner): FrontDoorPort {
  return {
    ensure: (inheritedExtraCaCerts) => {
      const up = ensureFrontDoor({ paths, launcherPid: process.pid, ports: realEnsurePorts(paths, spawnDaemon) });
      const trust = resolveTrustBundle({ caCertFile: paths.frontdoorCaCertFile, bundlesDir: paths.frontdoorCaBundlesDir, variable: "NODE_EXTRA_CA_CERTS", inherited: inheritedExtraCaCerts, fs: realTrustBundleFs });
      return {
        port: up.port,
        connectPort: up.connectPort,
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
