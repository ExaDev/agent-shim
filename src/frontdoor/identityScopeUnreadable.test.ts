import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { createIdentityNameReader } from "../identityStore";
import { buildLayoutPaths } from "../paths";
import { NO_ROUTE_OVERRIDES } from "../routeOverridesStore";
import { send, startWorld } from "./mainLoopRouteTestWorld";

const TIMEOUT_MS = 30_000;
/** The owner-only mode an identity.json is written with. */
const OWNER_ONLY = 0o600;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(path.join(root, "identities", "work", "identity.json"), OWNER_ONLY);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A state root holding identity `work` (id `work`), and a door whose overrides route `opus` by an identity entry for `work` and by a global entry. */
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-scope-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const file = path.join(paths.identitiesDir, "work", "identity.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: "work", allowAmbientCredential: false }), { mode: OWNER_ONLY });
  const table = { ...NO_ROUTE_OVERRIDES, global: { opus: "z/glm-global" }, identities: { work: { opus: "z/glm-work" } } };
  const door = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { routeOverrides: () => ({ table }), identityNameOf: createIdentityNameReader(paths).requireNameOf });
  return { door, file };
}

describe("the identity scope of a session whose identity.json cannot be read", () => {
  it("refuses the request naming the fault, never routing it by a lower scope, and routes by the identity scope once the file is readable again", async () => {
    if (process.getuid?.() === 0) return;
    const { door, file } = await world();
    try {
      expect((await send(door, { model: "claude-opus-5-5", requestClass: "main", identity: "work" })).status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.at(-1)?.model).toBe("glm-work");
      fs.chmodSync(file, 0);
      const refused = await send(door, { model: "claude-opus-5-5", requestClass: "main", identity: "work" });
      expect(refused.status, refused.text).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain("EACCES");
      expect(refused.text).not.toContain(file);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual(["glm-work"]);
      fs.chmodSync(file, OWNER_ONLY);
      expect((await send(door, { model: "claude-opus-5-5", requestClass: "main", identity: "work" })).status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual(["glm-work", "glm-work"]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("refuses the request when the file names no identity, rather than taking the session for no identity", async () => {
    const { door, file } = await world();
    try {
      fs.writeFileSync(file, "{ not json");
      const refused = await send(door, { model: "claude-opus-5-5", requestClass: "main", identity: "work" });
      expect(refused.status, refused.text).toBe(HTTP_STATUS.badRequest);
      expect(door.upstream.seen).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);
});

describe("an identity.json that cannot be read when no identity scope could decide the request", () => {
  it.each<[string, Record<string, unknown>]>([
    ["no overrides at all", {}],
    ["only a global override for another name", { global: { haiku: "z/glm-global" } }],
    ["an identity scope for another model only", { identities: { work: { haiku: "z/glm-h" } } }],
    ["the session's own entry for the model, which outranks every identity's", { sessions: { "s-1": { "claude-opus-5-5": "z/glm-s" } }, identities: { other: { opus: "z/glm-other" } } }],
  ])("routes the main loop as with no overrides, with %s", async (_label, tables) => {
    if (process.getuid?.() === 0) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-scope-none-"));
    roots.push(root);
    const paths = buildLayoutPaths(root);
    const file = path.join(paths.identitiesDir, "work", "identity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: "work", allowAmbientCredential: false }), { mode: OWNER_ONLY });
    fs.chmodSync(file, 0);
    const door = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { routeOverrides: () => ({ table: { ...NO_ROUTE_OVERRIDES, ...tables } }), identityNameOf: createIdentityNameReader(paths).requireNameOf });
    try {
      await send(door, { model: "z/glm-chosen", requestClass: "main", identity: "work" });
      const answered = await send(door, { model: "claude-opus-5-5", requestClass: "main", identity: "work" });
      expect(answered.status, answered.text).toBe(HTTP_STATUS.ok);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);
});

describe("an identity.json that cannot be read when another identity's scope could decide the request", () => {
  it("refuses the request naming the fault, since a rename may have given the session that identity's name", async () => {
    if (process.getuid?.() === 0) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-scope-other-"));
    roots.push(root);
    const paths = buildLayoutPaths(root);
    const file = path.join(paths.identitiesDir, "work", "identity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: "work", allowAmbientCredential: false }), { mode: OWNER_ONLY });
    fs.chmodSync(file, 0);
    const door = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { routeOverrides: () => ({ table: { ...NO_ROUTE_OVERRIDES, identities: { other: { opus: "z/glm-other" } } } }), identityNameOf: createIdentityNameReader(paths).requireNameOf });
    try {
      const answered = await send(door, { model: "claude-opus-5-5", requestClass: "main", identity: "work" });
      expect(answered.status, answered.text).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("EACCES");
      expect(door.upstream.seen).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);
});
