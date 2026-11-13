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
import { reservedProviderNameReason, requireUnreservedProviderName, isAutoModel } from "./reservedModelNames";

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

describe("the model auto, as a name", () => {
  it.each([["auto", true], ["auto[1m]", true], ["auto[1M]", true], ["AUTO", false], ["auto[2m]", false], ["autos", false], ["spark/auto", false], ["", false], [" auto", false]])("is read from %j as %s", (name, expected) => {
    expect(isAutoModel(name)).toBe(expected);
  });
});
