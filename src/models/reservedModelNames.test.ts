import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidProviderNameError } from "../config/names";
import { runDoctor } from "../doctorReport";
import { baseParams, findingsFor, provider } from "../doctorTestFixtures";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { renameProvider, type ProviderRenamePorts } from "../providerRename";
import { addProvider, providerExists } from "../providersStore";
import { realFarmFs } from "../realPorts";
import { UsageError } from "../cliError";
import { readModels, setVirtualModel } from "../modelsStore";
import { modelsFindings } from "./doctor";
import { reservedProviderNameReason, reservedVirtualModelNameReason, requireUnreservedProviderName } from "./reservedModelNames";

const RESERVED = ["auto", "opus", "sonnet", "haiku", "fable", "Opus", "default", "best", "opusplan", "Default", "OpusPlan", "claude-opus-5-5", "claude-sonnet-4-5[1m]", "auto[1m]", "auto[1M]", "default[1m]", "Default[1M]", "best[1m]", "opusplan[1m]", "opus[1m]"];
const FREE = ["Auto", "AUTO", "spark", "z", "opusx", "automatic", "my-opus-gateway", "claudette", "defaults", "bestest", "opus-plan"];
const BASE = { displayName: "Stand-in", baseUrl: "https://example.test/anthropic", sources: [{ env: "STAND_IN_TOKEN" }] };

describe("a provider may not be called a bare model name", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-names-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(RESERVED)("reserves %j, with the reason", (name) => {
    expect(reservedProviderNameReason(name)).toEqual(expect.any(String));
    expect(() => {
      requireUnreservedProviderName(name);
    }).toThrow(InvalidProviderNameError);
  });

  it.each(FREE)("leaves %j free", (name) => {
    expect(reservedProviderNameReason(name)).toBeUndefined();
  });

  it.each(RESERVED)("refuses `provider add` for %j, writing nothing", (name) => {
    expect(() => addProvider(paths, name, BASE)).toThrow(InvalidProviderNameError);
    expect(providerExists(paths, name)).toBe(false);
  });

  it.each(RESERVED)("refuses renaming a provider to %j, leaving it where it was", (name) => {
    addProvider(paths, "z", BASE);
    const ports: ProviderRenamePorts = { fs: realFarmFs, credentialCache: { port: { read: () => undefined, write: () => undefined, remove: () => undefined }, platform: "linux" } };
    expect(() => renameProvider(paths, "z", name, ports)).toThrow(InvalidProviderNameError);
    expect(providerExists(paths, "z")).toBe(true);
  });

  it.each(RESERVED)("has the doctor warn of an existing provider file called %j", (name) => {
    const report = runDoctor(baseParams({ providers: [provider(name, { displayName: "X", baseUrl: "https://example.test/anthropic", credential: { sources: [{ literal: "t" }] } })] }));
    const warned = findingsFor(report, "provider").filter((finding) => finding.severity === "warn");
    expect(warned.map((finding) => finding.message)).toContainEqual(expect.stringContaining("is called a bare model name"));
  });

  it("has the doctor say nothing of the sort about a free name", () => {
    const report = runDoctor(baseParams({ providers: [provider("spark", { displayName: "X", baseUrl: "https://example.test/anthropic", credential: { sources: [{ literal: "t" }] } })] }));
    expect(findingsFor(report, "provider").map((finding) => finding.message).join("\n")).not.toContain("bare model name");
  });
});

const RESERVED_VIRTUAL = ["auto", "auto[1m]", "auto/", "auto/z", "auto/pool:subs/sonnet"];
const FREE_VIRTUAL = ["fast", "Auto", "automatic", "z/auto", "autox/z"];

describe("a virtual model may not be called auto or a selector", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-virtual-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(RESERVED_VIRTUAL)("reserves %j, with the reason", (name) => {
    expect(reservedVirtualModelNameReason(name)).toEqual(expect.any(String));
  });

  it.each(FREE_VIRTUAL)("leaves %j free", (name) => {
    expect(reservedVirtualModelNameReason(name)).toBeUndefined();
  });

  it.each(RESERVED_VIRTUAL)("refuses defining a virtual model called %j, writing nothing", (name) => {
    expect(() => {
      setVirtualModel(paths, name, { mode: "ordered", members: ["z/glm-5.3"] });
    }).toThrow(UsageError);
    expect(readModels(paths)?.virtual?.[name]).toBeUndefined();
  });

  it("has the models doctor warn of an existing virtual model called a reserved name", () => {
    const findings = modelsFindings({ models: { virtual: { auto: { mode: "ordered", members: ["z/glm-5.3"] }, fast: { mode: "ordered", members: ["z/glm-5.3"] } } }, providers: ["z"], identities: [] });
    expect(findings.map((finding) => finding.severity)).toEqual(["warn"]);
    expect(findings[0]?.message).toContain('Virtual model "auto"');
  });
});
