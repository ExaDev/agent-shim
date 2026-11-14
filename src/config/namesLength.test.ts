import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { addIdentity } from "../identityStore";
import { identityLockPath } from "../launcher/lock";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { createProfile, removeProfile } from "../configProfilesStore";
import { addProvider, removeProvider } from "../providersStore";
import { MAX_NAME_BYTES } from "./names";

/** The widest a pid and the text form of a UUID can be, the worst case of the suffixes the store and the launcher add to a name. */
const WIDEST_PID = "4294967295";
const A_UUID = "123e4567-e89b-12d3-a456-426614174000";

// That the longest name is one byte short of being refused by both rules, and measured in bytes, is a case of the conformance corpus (conformance/function/names-length.json). These tests make files in the stores, which no case holds.

describe("the longest name a profile, provider or identity may have", () => {
  let home: string;
  let paths: LayoutPaths;
  const longest = "n".repeat(MAX_NAME_BYTES);

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "names-length-")));
    paths = buildLayoutPaths(path.join(home, ".agent-shim"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("is created and removed as a configuration profile, and its worst-case temporary file can be written", () => {
    createProfile(paths, longest);
    removeProfile(paths, longest);
    fs.writeFileSync(path.join(paths.configProfilesDir, `.${longest}.json.${WIDEST_PID}.${A_UUID}.tmp`), "{}");
  });

  it("is created and removed as a provider, and its worst-case temporary file can be written", () => {
    addProvider(paths, longest, { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", sources: [{ env: "Z_API_TOKEN" }] });
    removeProvider(paths, longest);
    fs.writeFileSync(path.join(paths.providersDir, `.${longest}.json.${WIDEST_PID}.${A_UUID}.tmp`), "{}");
  });

  it("is created as an identity, and the lock, scratch and previous entries a launch makes beside it can be made", () => {
    addIdentity(paths, longest);
    fs.writeFileSync(identityLockPath(paths.identitiesDir, longest), "");
    fs.mkdirSync(path.join(paths.identitiesDir, `.${longest}.scratch.${WIDEST_PID}.${A_UUID}`));
    fs.mkdirSync(path.join(paths.identitiesDir, `.${longest}.previous.${WIDEST_PID}.${A_UUID}`));
  });
});
