import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError } from "./cliError";
import { collectCheckReport } from "./checkReport";
import { ConfigFileNotJsonError, cosmiconfigReader } from "./config/load";
import { loadIdentity } from "./launcher/identity";
import { addIdentity } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { realFsPort } from "./realPorts";

/** Text standing in for a secret beside the syntax error, which cosmiconfig's rethrown parser message would quote. */
const SECRET = "sk-FAKESECRET";

/** A file whose value is not quoted, so the parser stops at it and its message quotes the text around the failure. */
const UNQUOTED = `{ "credential": { "env": ${SECRET} } }\n`;

/** Runs `attempt` and returns what it threw, or undefined when it did not. */
function thrownBy(attempt: () => unknown): unknown {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Asserts `failure` is the error for a file that is not JSON: it names `file` and repeats none of what the file held. */
function expectNamesFileOnly(failure: unknown, file: string): void {
  expect(failure).toBeInstanceOf(ConfigFileNotJsonError);
  expect(failure).toBeInstanceOf(CliError);
  const message = failure instanceof Error ? failure.message : "";
  expect(message).toContain(file);
  expect(message).toContain("is not valid JSON");
  expect(message).not.toContain(SECRET);
  expect(message).not.toContain("FAKE");
}

describe("a config file that is not JSON, read through cosmiconfig", () => {
  let root: string;
  let claudeHome: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "config-not-json-test-"));
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "config-not-json-claude-"));
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it("is reported by the reader as ConfigFileNotJsonError, naming the file and repeating none of its text", () => {
    const file = path.join(root, "garbled.json");
    fs.writeFileSync(file, UNQUOTED);
    expectNamesFileOnly(thrownBy(() => cosmiconfigReader()(file)), file);
  });

  it("is reported the same way for a YAML file the parser rejects, whose own message quotes a snippet", () => {
    const file = path.join(root, "garbled.yaml");
    fs.writeFileSync(file, `credential:\n  env: [${SECRET}\n  other: : :\n`);
    const failure = thrownBy(() => cosmiconfigReader()(file));
    expect(failure).toBeInstanceOf(ConfigFileNotJsonError);
    expect(failure instanceof Error ? failure.message : "").toBe(`${file} is not valid YAML.`);
    expect(failure instanceof Error ? failure.message : "").not.toContain(SECRET);
  });

  it("still reports a file that does not exist as absent, and a file that is empty as absent", () => {
    expect(cosmiconfigReader()(path.join(root, "missing.json"))).toBeUndefined();
    const empty = path.join(root, "empty.json");
    fs.writeFileSync(empty, "");
    expect(cosmiconfigReader()(empty)).toBeUndefined();
  });

  it("is reported by loadIdentity, which a launch, check and the statusline read an identity through", () => {
    addIdentity(paths, "work");
    const file = path.join(paths.identitiesDir, "work", "identity.json");
    fs.writeFileSync(file, UNQUOTED);
    expectNamesFileOnly(thrownBy(() => loadIdentity(paths.identitiesDir, "work", realFsPort)), file);
  });

  it("is reported by collectCheckReport for the identity file it selects", () => {
    addIdentity(paths, "work");
    const file = path.join(paths.identitiesDir, "work", "identity.json");
    fs.writeFileSync(file, UNQUOTED);
    expectNamesFileOnly(thrownBy(() => collectCheckReport({ paths, cwd: root, identity: "work", env: {} })), file);
  });

  it("is reported by collectCheckReport for the global config it reads the cascade from", () => {
    addIdentity(paths, "work");
    fs.writeFileSync(paths.globalConfigFile, UNQUOTED);
    expectNamesFileOnly(thrownBy(() => collectCheckReport({ paths, cwd: root, identity: "work", env: {} })), paths.globalConfigFile);
  });
});
