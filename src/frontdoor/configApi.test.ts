import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { identityExists, readIdentity } from "../identityStore";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { readPools } from "../poolStore";
import { readProvider } from "../providersStore";
import { listDirectoryRules } from "../directoryRulesStore";
import { profileExists } from "../configProfilesStore";
import { createConfigApiRouter } from "./configApi";

const TOKEN = "control-token-for-the-config-api-tests";
const LITERAL_PLACEHOLDER = "never-echoed-placeholder-value";

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-config-api-"));
  paths = buildLayoutPaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** The router under test as a typed client presenting `token` as its Bearer credential. */
function clientWith(token: string | undefined) {
  return createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths }), {
    context: { headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, afterResponse: () => undefined },
  });
}

/** The error code a rejected call carries, so a test asserts the refusal class rather than a message. */
async function codeOf(call: Readonly<Promise<unknown>>): Promise<string> {
  try {
    await call;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    throw error;
  }
  throw new Error("the call was expected to be refused");
}

describe("config API: authentication", () => {
  it("refuses a call that presents no control token or the wrong one", async () => {
    expect(await codeOf(clientWith(undefined).config.identity.add({ name: "work" }))).toBe("UNAUTHORIZED");
    expect(await codeOf(clientWith("not-the-token").config.identity.add({ name: "work" }))).toBe("UNAUTHORIZED");
    expect(identityExists(paths, "work")).toBe(false);
  });
});

describe("config API: identities", () => {
  it("creates, updates, selects and removes an identity through the same store the CLI writes", async () => {
    const api = clientWith(TOKEN).config;
    const created = await api.identity.add({ name: "work" });
    expect(created).toEqual({ action: "created", kind: "identity", name: "work", value: { name: "work", allowAmbientCredential: false } });
    expect(readIdentity(paths, "work")?.name).toBe("work");

    expect(await codeOf(api.identity.add({ name: "work" }))).toBe("CONFLICT");

    await api.profile.add({ name: "client" });
    const updated = await api.identity.set({ name: "work", defaultConfigProfile: "client", allowAmbientCredential: true });
    expect(updated.value).toEqual({ name: "work", defaultConfigProfile: "client", allowAmbientCredential: true });

    const cleared = await api.identity.set({ name: "work", defaultConfigProfile: false });
    expect(cleared.value.defaultConfigProfile).toBeUndefined();

    expect(await api.identity.use({ name: "work" })).toEqual({ action: "selected", kind: "identity", name: "work" });

    expect(await api.identity.remove({ name: "work", confirm: true })).toEqual({ action: "removed", kind: "identity", name: "work" });
    expect(identityExists(paths, "work")).toBe(false);
  });

  it("refuses names that do not exist, a missing profile and a change that names nothing", async () => {
    const api = clientWith(TOKEN).config;
    await api.identity.add({ name: "work" });
    expect(await codeOf(api.identity.set({ name: "ghost", allowAmbientCredential: true }))).toBe("NOT_FOUND");
    expect(await codeOf(api.identity.set({ name: "work", defaultConfigProfile: "no-such-profile" }))).toBe("NOT_FOUND");
    expect(await codeOf(api.identity.set({ name: "work" }))).toBe("BAD_REQUEST");
    expect(await codeOf(api.identity.use({ name: "ghost" }))).toBe("NOT_FOUND");
  });

  it("refuses a removal that does not state its confirmation and leaves the identity", async () => {
    const api = clientWith(TOKEN).config;
    await api.identity.add({ name: "work" });
    expect(await codeOf(api.identity.remove({ name: "work", confirm: false }))).toBe("BAD_REQUEST");
    expect(identityExists(paths, "work")).toBe(true);
  });

  it("sets a credential from a named source and reports its kind, never a source's value", async () => {
    const api = clientWith(TOKEN).config;
    await api.identity.add({ name: "work" });
    const withEnv = await api.identity.set({ name: "work", credential: { sources: [{ env: "WORK_TOKEN" }, { literal: LITERAL_PLACEHOLDER }], target: "oauthToken", cache: { ttl: "12h" } } });
    expect(withEnv.value.credential).toEqual({ target: "oauthToken", sources: [{ kind: "env", variable: "WORK_TOKEN" }, { kind: "literal" }], cache: { ttl: "12h" } });
    expect(JSON.stringify(withEnv)).not.toContain(LITERAL_PLACEHOLDER);

    const retargeted = await api.identity.set({ name: "work", credential: { target: "bearer", cache: false } });
    expect(retargeted.value.credential).toEqual({ target: "bearer", sources: [{ kind: "env", variable: "WORK_TOKEN" }, { kind: "literal" }] });

    const removed = await api.identity.set({ name: "work", credential: false });
    expect(removed.value.credential).toBeUndefined();
  });

  it("refuses a command credential source and writes nothing", async () => {
    const api = clientWith(TOKEN).config;
    await api.identity.add({ name: "work" });
    // The input type does not offer the kind, so the call is built untyped, as a REST caller would send it.
    const body: unknown = { name: "work", credential: { sources: [{ command: ["sh", "-c", "echo token"] }] } };
    const set = api.identity.set as (input: unknown) => Promise<unknown>;
    expect(await codeOf(set(body))).toBe("BAD_REQUEST");
    expect(readIdentity(paths, "work")?.credential).toBeUndefined();
  });
});

describe("config API: configuration profiles", () => {
  it("creates, changes, selects and removes a profile", async () => {
    const api = clientWith(TOKEN).config;
    const created = await api.profile.add({ name: "client", description: "Client work" });
    expect(created.value).toEqual({ description: "Client work" });

    await api.profile.add({ name: "base" });
    const updated = await api.profile.set({
      name: "client",
      extends: ["base"],
      category: { history: false },
      launch: { headroom: true, provider: "z", claudeVersion: "2.1.220" },
    });
    expect(updated.value).toMatchObject({ extends: ["base"], categories: { history: false }, launch: { headroom: true, provider: "z", claudeVersion: "2.1.220" } });

    const cleared = await api.profile.set({ name: "client", extends: false, description: false, launch: { provider: false } });
    expect(cleared.value.extends).toBeUndefined();
    expect(cleared.value.description).toBeUndefined();
    expect(cleared.value.launch?.provider).toBeUndefined();

    expect(await api.profile.use({ name: "client" })).toEqual({ action: "selected", kind: "profile", name: "client" });
    expect(await api.profile.remove({ name: "client", confirm: true })).toEqual({ action: "removed", kind: "profile", name: "client" });
    expect(profileExists(paths, "client")).toBe(false);
  });

  it("refuses a duplicate, an unknown profile, a category that cannot be toggled and an empty change", async () => {
    const api = clientWith(TOKEN).config;
    await api.profile.add({ name: "client" });
    expect(await codeOf(api.profile.add({ name: "client" }))).toBe("CONFLICT");
    expect(await codeOf(api.profile.set({ name: "ghost", description: "x" }))).toBe("NOT_FOUND");
    expect(await codeOf(api.profile.set({ name: "client", category: { secret: true } }))).toBe("BAD_REQUEST");
    expect(await codeOf(api.profile.set({ name: "client" }))).toBe("BAD_REQUEST");
    expect(await codeOf(api.profile.use({ name: "ghost" }))).toBe("NOT_FOUND");
  });
});

describe("config API: pools", () => {
  it("defines, changes, selects and removes a pool of existing identities", async () => {
    const api = clientWith(TOKEN).config;
    await api.identity.add({ name: "work" });
    await api.identity.add({ name: "personal" });

    expect(await codeOf(api.pool.add({ name: "subs", identities: ["work", "ghost"] }))).toBe("NOT_FOUND");
    expect(readPools(paths).subs).toBeUndefined();

    const created = await api.pool.add({ name: "subs", identities: ["work", "personal"], preference: "listed" });
    expect(created.value).toEqual({ identities: ["work", "personal"], preference: "listed" });
    expect(await codeOf(api.pool.add({ name: "subs", identities: ["work"] }))).toBe("CONFLICT");

    const reordered = await api.pool.set({ name: "subs", identities: ["personal", "work"], preference: false });
    expect(reordered.value).toEqual({ identities: ["personal", "work"] });
    expect(await codeOf(api.pool.set({ name: "subs" }))).toBe("BAD_REQUEST");

    expect(await api.pool.use({ name: "subs" })).toEqual({ action: "selected", kind: "pool", name: "subs" });
    expect(await codeOf(api.pool.use({ name: "ghost" }))).toBe("NOT_FOUND");

    expect(await api.pool.remove({ name: "subs", confirm: true })).toEqual({ action: "removed", kind: "pool", name: "subs" });
    expect(readPools(paths).subs).toBeUndefined();
  });
});

describe("config API: providers", () => {
  it("creates an http provider with a named credential source, changes it and removes it", async () => {
    const api = clientWith(TOKEN).config;
    const created = await api.provider.add({
      name: "z",
      displayName: "z.ai",
      baseUrl: "https://api.z.ai/api/anthropic",
      credential: { sources: [{ env: "Z_API_TOKEN" }], target: "apiKey" },
    });
    expect(created.value).toEqual({
      name: "z",
      kind: "http",
      displayName: "z.ai",
      baseUrl: "https://api.z.ai/api/anthropic",
      credential: { target: "apiKey", sources: [{ kind: "env", variable: "Z_API_TOKEN" }] },
    });

    const updated = await api.provider.set({ name: "z", displayName: "Z", credential: { sources: [{ op: "op://vault/z/credential" }], cache: { ttl: "1h" } } });
    expect(updated.value.displayName).toBe("Z");
    expect(updated.value.credential).toEqual({ target: "apiKey", sources: [{ kind: "op", reference: "op://vault/z/credential" }], cache: { ttl: "1h" } });

    expect(await api.provider.remove({ name: "z", confirm: true })).toEqual({ action: "removed", kind: "provider", name: "z" });
    expect(readProvider(paths, "z")).toBeUndefined();
  });

  it("creates a codex provider and refuses a base URL on it", async () => {
    const api = clientWith(TOKEN).config;
    const created = await api.provider.add({ name: "codex", kind: "codex", displayName: "Codex", credential: { sources: [{ literal: LITERAL_PLACEHOLDER }] }, codex: { effort: "medium" } });
    expect(created.value.kind).toBe("codex");
    expect(created.value.codex).toEqual({ effort: "medium" });
    expect(JSON.stringify(created)).not.toContain(LITERAL_PLACEHOLDER);
    expect(await codeOf(api.provider.add({ name: "bad", kind: "codex", displayName: "Bad", baseUrl: "https://example.com", credential: { sources: [{ env: "X" }] } }))).toBe("BAD_REQUEST");
  });

  it("refuses a command credential source and an env block, and leaves the provider untouched", async () => {
    const api = clientWith(TOKEN).config;
    const add = api.provider.add as (input: unknown) => Promise<unknown>;
    const base = { name: "z", displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic" };
    expect(await codeOf(add({ ...base, credential: { sources: [{ command: ["sh", "-c", "echo token"] }] } }))).toBe("BAD_REQUEST");
    expect(await codeOf(add({ ...base, credential: { sources: [{ env: "Z" }] }, env: { NODE_OPTIONS: "--require /tmp/x.js" } }))).toBe("BAD_REQUEST");
    expect(readProvider(paths, "z")).toBeUndefined();
  });

  it("refuses a duplicate, an unknown provider and an empty change", async () => {
    const api = clientWith(TOKEN).config;
    await api.provider.add({ name: "z", displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } });
    expect(await codeOf(api.provider.add({ name: "z", displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } }))).toBe("CONFLICT");
    expect(await codeOf(api.provider.set({ name: "ghost", displayName: "x" }))).toBe("NOT_FOUND");
    expect(await codeOf(api.provider.set({ name: "z" }))).toBe("BAD_REQUEST");
    expect(await codeOf(api.provider.set({ name: "z", baseUrl: "https://elsewhere.example.com" }))).toBe("BAD_REQUEST");
    expect(readProvider(paths, "z")).toMatchObject({ baseUrl: "https://api.z.ai/api/anthropic" });
    const moved = await api.provider.set({ name: "z", baseUrl: "https://elsewhere.example.com", credential: { sources: [{ env: "Z2" }] } });
    expect(moved.value).toMatchObject({ baseUrl: "https://elsewhere.example.com" });
    expect((await api.provider.set({ name: "z", baseUrl: "https://elsewhere.example.com", displayName: "z" })).value).toMatchObject({ displayName: "z" });
    expect(await codeOf(api.provider.remove({ name: "z", confirm: false }))).toBe("BAD_REQUEST");
    expect(await codeOf(api.provider.remove({ name: "ghost", confirm: true }))).toBe("NOT_FOUND");
  });
});

describe("config API: directory rules", () => {
  it("adds, changes and removes a rule that names an existing profile and identity", async () => {
    const api = clientWith(TOKEN).config;
    await api.profile.add({ name: "client" });
    await api.identity.add({ name: "work" });

    expect(await codeOf(api.rule.add({ path: "/work/acme", identity: "ghost" }))).toBe("NOT_FOUND");
    expect(await codeOf(api.rule.add({ path: "/work/acme", configProfile: "ghost" }))).toBe("NOT_FOUND");
    expect(await codeOf(api.rule.add({ path: "/work/acme" }))).toBe("BAD_REQUEST");

    const created = await api.rule.add({ path: "/work/acme", configProfile: "client" });
    expect(created).toEqual({ action: "created", kind: "rule", name: "/work/acme", value: { path: "/work/acme", configProfile: "client" } });
    expect(await codeOf(api.rule.add({ path: "/work/acme", identity: "work" }))).toBe("CONFLICT");

    const updated = await api.rule.set({ path: "/work/acme", identity: "work" });
    expect(updated.value).toEqual({ path: "/work/acme", configProfile: "client", identity: "work" });
    expect(await codeOf(api.rule.set({ path: "/work/acme" }))).toBe("BAD_REQUEST");
    expect(await codeOf(api.rule.set({ path: "/nowhere", identity: "work" }))).toBe("NOT_FOUND");

    expect(await api.rule.remove({ path: "/work/acme", confirm: true })).toEqual({ action: "removed", kind: "rule", name: "/work/acme" });
    expect(listDirectoryRules(paths)).toEqual([]);
  });
});
