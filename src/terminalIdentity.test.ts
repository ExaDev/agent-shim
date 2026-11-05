import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { realFarmFs, realFsPort } from "./realPorts";
import { readyTerminalIdentity } from "./terminalIdentity";
import { identityIdOf, listIdentities } from "./identityStore";
import { fakeSleep, shippedClassification } from "./test-helpers";

/** A superseded farm of the identity stored under `work`, named as a resync whose process (999) is gone names it. */
const SUPERSEDED_WORK = ".work.previous.999.0f8fad5b-d9cb-469f-a165-70867728950e";

describe("a launch from a terminal of an identity whose identity.json an interrupted resync left in a superseded farm", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-identity-test-"));
    paths = buildLayoutPaths(root);
    // The identity stored under work is named client, so the name the launch selects is not its id.
    fs.mkdirSync(path.join(paths.identitiesDir, SUPERSEDED_WORK), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, SUPERSEDED_WORK, "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Readies `name` as `runClaude` does on a terminal, recording each wizard offer and each warning. */
  async function ready(name: string): Promise<{ readonly ready: boolean; readonly runWizard: ReturnType<typeof vi.fn>; readonly warnings: readonly string[] }> {
    const warnings: string[] = [];
    const runWizard = vi.fn(async () => Promise.resolve(true));
    const result = await readyTerminalIdentity({
      identitiesDir: paths.identitiesDir,
      name,
      fs: realFsPort,
      farm: { fs: realFarmFs, now: () => 0, lock: { pid: process.pid, isRunning: () => false, sleep: fakeSleep().sleep }, classification: { defaults: shippedClassification } },
      warn: (line) => {
        warnings.push(line);
      },
      runWizard,
    });
    return { ready: result, runWizard, warnings };
  }

  /** Asserts the identity is back in its own directory, holding its identity.json, with no superseded farm left and nothing listed as a problem. */
  function expectRestored(): void {
    expect(JSON.parse(fs.readFileSync(path.join(paths.identitiesDir, "work", "identity.json"), "utf8"))).toEqual({ name: "client", allowAmbientCredential: false });
    expect(fs.existsSync(path.join(paths.identitiesDir, SUPERSEDED_WORK))).toBe(false);
    expect(identityIdOf(paths, "client")).toBe("work");
    expect(listIdentities(paths).map((listing) => [listing.name, listing.id, "problem" in listing])).toEqual([["client", "work", false]]);
  }

  it("puts it back, with no wizard, when its directory was moved aside and is gone", async () => {
    const { ready: isReady, runWizard, warnings } = await ready("client");
    expect(isReady).toBe(true);
    expect(runWizard).not.toHaveBeenCalled();
    expectRestored();
    expect(warnings.join("\n")).toContain(`restored the farm from ${SUPERSEDED_WORK}`);
  });

  it("puts it back, with no wizard, when its directory is present without identity.json", async () => {
    fs.mkdirSync(path.join(paths.identitiesDir, "work"));
    const { ready: isReady, runWizard } = await ready("client");
    expect(isReady).toBe(true);
    expect(runWizard).not.toHaveBeenCalled();
    expectRestored();
  });

  it("offers the wizard for a name no identity claims, and touches no farm", async () => {
    const before = fs.readdirSync(paths.identitiesDir).sort();
    const { ready: isReady, runWizard } = await ready("someone");
    expect(isReady).toBe(true);
    expect(runWizard).toHaveBeenCalledWith("someone");
    expect(fs.readdirSync(paths.identitiesDir).sort()).toEqual(before);
  });
});
