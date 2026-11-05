import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_FAILURE } from "./cliError";
import { reportFatalError } from "./cliReport";
import { collectDoctorReport } from "./doctorReport";
import { findingsFor } from "./doctorTestFixtures";
import { describeIdentityMove } from "./identityRename";
import { buildProgram } from "./program";
import { realIdentityRenamePorts } from "./realIdentityRename";
import { fakeCommandDeps } from "./test-helpers";
import { tryRunAtIdentityShortcut } from "./identityManager";
import { addIdentity, DisplacedIdentityError, IdentityAlreadyExistsError, identityIdOf, listIdentities, setIdentityLabel } from "./identityStore";
import { resolveIdentityId } from "./launcher/identity";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { realFsPort } from "./realPorts";

/** A superseded farm of the identity stored under `work`, named as a resync names it. */
const SUPERSEDED_WORK = ".work.previous.4242.0f8fad5b-d9cb-469f-a165-70867728950e";

describe("an identity a resync killed after its swap and before it carried identity.json over", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-half-swapped-test-"));
    paths = buildLayoutPaths(root);
    // The new farm is in place with nothing carried into it yet; the old farm beside it still holds the record, which names client.
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.mkdirSync(path.join(paths.identitiesDir, SUPERSEDED_WORK), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, SUPERSEDED_WORK, "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is found by its name, by the store and the launcher alike, so the launch's recovery runs", () => {
    expect(identityIdOf(paths, "client")).toBe("work");
    expect(resolveIdentityId(paths.identitiesDir, "client", realFsPort)).toBe("work");
  });

  it("keeps its name from a new identity, so recovery never leaves two identities named client", () => {
    expect(() => addIdentity(paths, "client")).toThrow(IdentityAlreadyExistsError);
    expect(fs.readdirSync(paths.identitiesDir).filter((entry) => !entry.startsWith("."))).toEqual(["work"]);
    expect(listIdentities(paths)).toEqual([{ name: "client", id: "work", isActive: false, problem: "its identity.json is in a superseded farm an interrupted resync left; the next launch of it puts it back", displaced: true }]);
  });

  /** Runs `agent-shim` with `argv` against this state root, returning the exit status and what it printed. */
  async function run(argv: readonly string[]): Promise<{ readonly status: number; readonly printed: string }> {
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    try {
      await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn() }).parseAsync([...argv], { from: "user" });
      return { status: 0, printed: out.join("\n") };
    } catch (error) {
      return {
        status: reportFatalError(error, {
          writeErr: (line) => {
            out.push(line);
          },
          env: {},
        }),
        printed: out.join("\n"),
      };
    } finally {
      log.mockRestore();
    }
  }

  it("is listed and shown with what puts it back, and set and --move refuse it with that, as rename does", async () => {
    const listed = await run(["identity", "list"]);
    expect(listed.printed).toContain("Run `agent-shim doctor` for the full detail on every displaced entry.");
    expect(listed.printed).not.toContain("unreadable");
    expect(listed.printed).toContain("client (id: work) [displaced: its identity.json is in a superseded farm an interrupted resync left; the next launch of it puts it back]");
    expect((await run(["identity", "show", "client"])).printed).toContain("Displaced: its identity.json is in a superseded farm an interrupted resync left; the next launch of it puts it back");
    const set = await run(["identity", "set", "client", "--label", "x"]);
    expect(set.status).toBe(EXIT_FAILURE);
    expect(set.printed).toContain('Identity "client" cannot be changed yet: a resync of it was interrupted and its identity.json is in a superseded farm beside identities/work, which holds no identity.json yet.');
    expect(() => setIdentityLabel(paths, "client", "x")).toThrow(DisplacedIdentityError);
    // --move takes an identity whose directory carries its name: desk, stored under desk, displaced the same way.
    fs.mkdirSync(path.join(paths.identitiesDir, "desk"), { recursive: true });
    const deskFarm = path.join(paths.identitiesDir, ".desk.previous.4242.0f8fad5b-d9cb-469f-a165-70867728950e");
    fs.mkdirSync(deskFarm, { recursive: true });
    fs.writeFileSync(path.join(deskFarm, "identity.json"), JSON.stringify({ name: "desk", allowAmbientCredential: false }));
    expect(() => describeIdentityMove(paths, "desk", "job", realIdentityRenamePorts(paths))).toThrow('Identity "desk" cannot be moved yet');
  });

  it("is selected by `identity use` and the `@client` shortcut, which resolve it as the launch does, so a missing identity's refusal never fires", async () => {
    expect((await run(["identity", "use", "client"])).status).toBe(0);
    expect(fs.readFileSync(paths.activeIdentityFile, "utf8").trim()).toBe("client");
    fs.rmSync(paths.activeIdentityFile);
    expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["@client"], { run: { run: () => ({ status: 1, stdout: "", stderr: "" }) }, platform: "linux" })).toBe(true);
    expect(fs.readFileSync(paths.activeIdentityFile, "utf8").trim()).toBe("client");
  });

  it("is reported by the real doctor as displaced, with what puts it back, and not as a missing file", () => {
    const findings = findingsFor(collectDoctorReport({ paths, env: { PATH: "" } }), "identity").filter((finding) => finding.severity !== "pass");
    expect(findings.map((finding) => [finding.severity, finding.message])).toEqual([["warn", 'Identity "client" has no identity.json in identities/work, which holds none yet: its identity.json is in a superseded farm a resync left when it was interrupted. The next launch of "client" puts it back.']]);
  });
});
