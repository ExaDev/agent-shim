import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const JITI = path.join(SOURCE, "..", "node_modules", "jiti", "lib", "jiti-cli.mjs");

/**
 * Runs `identity rename work client` in a child process and kills it with SIGKILL, which no handler sees and so no rollback follows, at the moment `when` names: `after-name`, once the identity's identity.json carries the new name and before the rename removes its record; `before-name`, once the recorded picks (the last reference) are rewritten and before the name is. `stateRoot` is the state root it renames in (with an identity `work`), and `root` holds the script and is the child's home. Returns the child's signal.
 */
export function killedRename(root: string, stateRoot: string, when: "after-name" | "before-name"): NodeJS.Signals | null {
  const script = path.join(root, "killed-rename.ts");
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import { renameIdentity } from ${JSON.stringify(path.join(SOURCE, "identityRename.ts"))};
import { buildLayoutPaths } from ${JSON.stringify(path.join(SOURCE, "paths.ts"))};
import { realIdentityRenamePorts } from ${JSON.stringify(path.join(SOURCE, "realIdentityRename.ts"))};
import { realFarmFs } from ${JSON.stringify(path.join(SOURCE, "realPorts.ts"))};
const paths = buildLayoutPaths(${JSON.stringify(stateRoot)});
const ports = realIdentityRenamePorts(paths);
const named = () => JSON.parse(fs.readFileSync(paths.identitiesDir + "/work/identity.json", "utf8")).name;
const originalRmSync = fs.rmSync.bind(fs);
fs.rmSync = (target, options) => {
  // The record is removed once the name step has written the new name into identity.json.
  if (${JSON.stringify(when)} === "after-name" && String(target).startsWith(paths.identityNameRenamesDir) && named() === "client") {
    process.kill(process.pid, "SIGKILL");
  }
  originalRmSync(target, options);
};
const fsPort = {
  ...realFarmFs,
  writeFilePrivate: (file, contents, options) => {
    realFarmFs.writeFilePrivate(file, contents, options);
    if (${JSON.stringify(when)} === "before-name" && file === paths.usagePicksFile) {
      process.kill(process.pid, "SIGKILL");
    }
  },
};
await renameIdentity(paths, "work", "client", { ...ports, fs: fsPort });
`,
  );
  return spawnSync(process.execPath, [JITI, script], { env: { PATH: process.env.PATH, HOME: root, AGENT_SHIM_HOME: stateRoot }, stdio: "pipe" }).signal;
}
