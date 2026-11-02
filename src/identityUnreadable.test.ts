import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError } from "./cliError";
import { collectDoctorReport } from "./doctorReport";
import { describeIdentityRename, renameIdentity } from "./identityRename";
import { createWorld, treeOf, type World } from "./identityRenameTestWorld";
import { listIdentities } from "./identityStore";
import { readDirectoryRules } from "./directoryRulesStore";
import { buildProgram } from "./program";
import { fakeCommandDeps } from "./test-helpers";

/** Text standing in for a secret that sits beside the syntax error in a file, which V8's own message would quote. */
const SECRET = "madeupsecretvalue";

/** An identity.json that is not JSON: the literal is not quoted, and the parser's message quotes the text around the failure. */
const BROKEN_IDENTITY = `{ "name": "personal", "credential": { "sources": [{ "literal": ${SECRET} }] } }\n`;

describe("an identity.json that is not JSON", () => {
  let world: World;
  let out: string[];

  beforeEach(() => {
    world = createWorld();
    fs.writeFileSync(path.join(world.directory("personal"), "identity.json"), BROKEN_IDENTITY);
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  async function run(argv: readonly string[]): Promise<void> {
    await buildProgram({ ...fakeCommandDeps(world.paths), runClaude: vi.fn() }).parseAsync([...argv], { from: "user" });
  }

  it("is listed as unreadable, saying only that it is not valid JSON", () => {
    const entry = listIdentities(world.paths).find((candidate) => candidate.name === "personal");
    expect(entry?.problem).toBe("is not valid JSON");
  });

  it("is shown by identity list and identity show without any of its text", async () => {
    await run(["identity", "list"]);
    await run(["identity", "show", "personal"]);
    await run(["identity", "list", "--json"]);
    await run(["identity", "show", "personal", "--json"]);
    const printed = out.join("\n");
    expect(printed).toContain("is not valid JSON");
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain("madeup");
  });

  it("is named in a rename's refusal, when it names a path the rename moves, without any of its text", async () => {
    fs.writeFileSync(path.join(world.directory("personal"), "identity.json"), `{ "credential": { "sources": [{ "file": "${path.join(world.root, "credentials", "work.token")}" }, ${SECRET} ] } }\n`);
    const before = treeOf(world.root);
    const attempts = [
      async (): Promise<void> => {
        await Promise.resolve(describeIdentityRename(world.paths, "work", "client", world.ports()));
      },
      async (): Promise<void> => {
        await renameIdentity(world.paths, "work", "client", world.ports());
      },
    ];
    for (const attempt of attempts) {
      const failure: unknown = await attempt().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(CliError);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toContain("identities/personal/identity.json");
      expect(message).toContain("is not valid JSON");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("madeup");
    }
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is reported by doctor without any of its text", () => {
    const report = collectDoctorReport({ paths: world.paths, env: { PATH: "" } });
    const identityMessages = report.findings.filter((finding) => finding.section === "identity").map((finding) => finding.message);
    expect(identityMessages.some((message) => message.includes("is not valid JSON"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("madeup");
  });
});

describe("the identity being renamed has an identity.json that is not JSON", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
    fs.writeFileSync(path.join(world.directory("work"), "identity.json"), BROKEN_IDENTITY.replace('"personal"', '"work"'));
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is refused in the dry run and the real run with a message that names the file and repeats none of its text", async () => {
    const before = treeOf(world.root);
    const attempts = [
      async (): Promise<void> => {
        await Promise.resolve(describeIdentityRename(world.paths, "work", "client", world.ports()));
      },
      async (): Promise<void> => {
        await renameIdentity(world.paths, "work", "client", world.ports());
      },
    ];
    for (const attempt of attempts) {
      const failure: unknown = await attempt().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(CliError);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toContain(path.join(world.directory("work"), "identity.json"));
      expect(message).toContain("is not valid JSON");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("madeup");
    }
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is refused by identity set with the same message, since every reader of a stored file shares it", async () => {
    const failure: unknown = await buildProgram({ ...fakeCommandDeps(world.paths), runClaude: vi.fn() })
      .parseAsync(["identity", "set", "work", "--label", "Example Org"], { from: "user" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(CliError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("is not valid JSON");
    expect(message).not.toContain("madeup");
  });
});

describe("a directory-rules.json that is not JSON", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
    fs.writeFileSync(world.paths.directoryRulesFile, `{ "rules": [{ "path": "/example", "secret": ${SECRET} }] }\n`);
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is refused with a message that names the file and repeats none of its text", () => {
    const failure: unknown = (() => {
      try {
        readDirectoryRules(world.paths);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CliError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain(world.paths.directoryRulesFile);
    expect(message).not.toContain("madeup");
  });
});

describe("a provider.json that is not JSON, in doctor", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
    fs.mkdirSync(world.paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(world.paths.providersDir, "z.json"), `{ "displayName": "z.ai", "credential": { "sources": [{ "literal": ${SECRET} }] } }\n`);
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is reported as not valid JSON without any of its text", () => {
    const report = collectDoctorReport({ paths: world.paths, env: { PATH: "" } });
    const providerMessages = report.findings.filter((finding) => finding.section === "provider").map((finding) => finding.message);
    expect(providerMessages.some((message) => message.includes("is not valid JSON"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("madeup");
  });
});
