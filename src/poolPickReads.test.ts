import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLauncherArgv } from "./launcher/argv";
import { decideIdentity } from "./launcher/identity";
import { resolvePoolLaunch } from "./launcher/pool";
import type { FsPort } from "./launcher/ports";
import { IdentityPickerCancelledError, runIdentityPicker } from "./launcher/runPicker";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { collectPoolPick } from "./poolPickReport";
import { realFarmFs, realFsPort } from "./realPorts";
import { fakeLog } from "./test-helpers";

/** The pool's members, each stored under an id that is not its name, as a rename of the name alone leaves them. */
const MEMBERS = [
  { id: "work", name: "alpha" },
  { id: "work-2", name: "beta" },
  { id: "work-3", name: "gamma" },
] as const;

describe("ranking a pool", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-pick-reads-test-"));
    paths = buildLayoutPaths(root);
    for (const { id, name } of MEMBERS) {
      fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
      fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), JSON.stringify({ name, allowAmbientCredential: false }));
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The real configuration port, and how many `identity.json` files it has read. */
  function countingFs(): { readonly fs: FsPort; readonly reads: () => number } {
    let reads = 0;
    return {
      fs: {
        ...realFsPort,
        readConfigFile: (file) => {
          if (file.endsWith("identity.json")) {
            reads += 1;
          }
          return realFsPort.readConfigFile(file);
        },
      },
      reads: () => reads,
    };
  }

  const pools = { subs: { identities: MEMBERS.map((member) => member.name) } };

  it("reads each identity.json once for a pool pick report, however many members it resolves", () => {
    const counting = countingFs();
    const report = collectPoolPick({ paths, fs: counting.fs, usageFs: realFarmFs, poolName: "subs", pools, directory: "/example/project", nowMs: Date.now() });
    expect(report.candidates.map((candidate) => candidate.identity).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(counting.reads()).toBe(MEMBERS.length);
  });

  it("reads each identity.json once for a pool launch, however many members it ranks", () => {
    const counting = countingFs();
    const resolution = resolvePoolLaunch({ poolName: "subs", selectedVia: "the command line", pools, paths, fs: counting.fs, usageFs: realFarmFs, cwd: "/example/project", now: () => Date.now(), sleep: () => undefined, passthrough: [], wait: false, recordPick: false, log: fakeLog() });
    expect(resolution.ok).toBe(true);
    expect(counting.reads()).toBe(MEMBERS.length);
  });

  it("reads each identity.json once for the picker's pool context, however many members it lists", async () => {
    const counting = countingFs();
    const parsed = parseLauncherArgv(["@pool:subs", "--pick"]);
    const listed: string[] = [];
    await runIdentityPicker({
      parsed,
      decision: decideIdentity({ env: {}, argv0Identity: parsed.identity, readActiveIdentityFile: () => undefined }),
      interactive: true,
      paths,
      fs: counting.fs,
      usageFs: realFarmFs,
      pools,
      cwd: "/example/project",
      now: () => Date.now(),
      identityNames: () => MEMBERS.map((member) => member.name),
      picker: {
        pick: async (request) => {
          listed.push(...request.entries.map((entry) => entry.value));
          return await Promise.resolve({ kind: "cancelled" as const });
        },
      },
    }).catch((error: unknown) => {
      if (!(error instanceof IdentityPickerCancelledError)) {
        throw error;
      }
    });
    expect(listed.sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(counting.reads()).toBe(MEMBERS.length);
  });
});
