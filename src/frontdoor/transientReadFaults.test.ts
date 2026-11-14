import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { createRouteOverridesReader, NO_ROUTE_OVERRIDES } from "../routeOverridesStore";
import { raiseUnreadableCatalogue } from "../storedCatalogue";
import { errorWithCode } from "../test-helpers";
import { PROVIDERS_DIR, Z_OPUS_MODEL, send, startWorld } from "./mainLoopRouteTestWorld";

const TIMEOUT_MS = 30_000;
const OVERRIDES_FILE = "/state/route-overrides.json";

/** The failures of the moment a read can meet: none says anything about the file. */
const TRANSIENT = ["EMFILE", "ENFILE", "EAGAIN", "EIO", "EBUSY", "EINTR"] as const;

/** A route overrides file that routes `opus` to `z/glm-9`, at one unchanging revision, whose reads throw `fault()` while it returns an error. */
function overridesFile(fault: () => Error | undefined) {
  let reads = 0;
  return {
    reads: () => reads,
    port: {
      fileRevision: (file: string) => (file === OVERRIDES_FILE ? "rev-1" : undefined),
      readFileUtf8: (file: string) => {
        reads += 1;
        const error = fault();
        if (error !== undefined) throw error;
        return file === OVERRIDES_FILE ? JSON.stringify({ ...NO_ROUTE_OVERRIDES, global: { opus: "z/glm-9" } }) : undefined;
      },
    },
  };
}

describe("a local read that fails for the moment", () => {
  it.each(TRANSIENT)("answers a %s on the route overrides file as retryable, keeps nothing, and routes by the file once the read succeeds", async (code) => {
    let failing = true;
    const file = overridesFile(() => (failing ? errorWithCode(`${code}: failed, open '${OVERRIDES_FILE}'`, code) : undefined));
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { routeOverrides: createRouteOverridesReader(file.port, OVERRIDES_FILE, () => undefined) });
    try {
      const refused = await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      expect(refused.status, refused.text).toBe(HTTP_STATUS.serviceUnavailable);
      expect(refused.text).toContain(code);
      expect(refused.text).toContain("try the request again");
      expect(refused.text).not.toContain("agent-shim doctor");
      expect(refused.text).not.toContain(OVERRIDES_FILE);
      expect(world.upstream.seen).toEqual([]);
      failing = false;
      const served = await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      expect(served.status, served.text).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-9"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("still keeps a fault of the file itself under its revision, and answers it as the person's to fix", async () => {
    const file = overridesFile(() => errorWithCode(`EACCES: permission denied, open '${OVERRIDES_FILE}'`, "EACCES"));
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { routeOverrides: createRouteOverridesReader(file.port, OVERRIDES_FILE, () => undefined) });
    try {
      const first = await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      expect(first.status).toBe(HTTP_STATUS.badRequest);
      expect(first.text).toContain("agent-shim doctor");
      expect(file.reads()).toBe(1);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it.each(TRANSIENT)("answers a %s on a provider's file as retryable, never as that file being invalid, and serves it once the read succeeds", async (code) => {
    const world = await startWorld();
    try {
      world.failRead(`${PROVIDERS_DIR}/z.json`, errorWithCode(`${code}: failed, open '${PROVIDERS_DIR}/z.json'`, code));
      const refused = await send(world, { model: "auto/provider:z/opus", requestClass: "main" });
      expect(refused.status, refused.text).toBe(HTTP_STATUS.serviceUnavailable);
      expect(refused.text).not.toContain("is invalid");
      expect(refused.text).not.toContain(PROVIDERS_DIR);
      world.failRead(`${PROVIDERS_DIR}/z.json`, undefined);
      const served = await send(world, { model: "auto/provider:z/opus", requestClass: "main" });
      expect(served.status, served.text).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([Z_OPUS_MODEL]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it.each(TRANSIENT)("answers a %s listing the providers directory as retryable, keeps no empty listing, and serves the provider once the listing succeeds", async (code) => {
    const world = await startWorld();
    try {
      world.failRead(PROVIDERS_DIR, errorWithCode(`${code}: failed, scandir '${PROVIDERS_DIR}'`, code));
      const refused = await send(world, { model: "auto/provider:z/opus", requestClass: "main" });
      expect(refused.status, refused.text).toBe(HTTP_STATUS.serviceUnavailable);
      expect(refused.text).not.toContain(PROVIDERS_DIR);
      world.failRead(PROVIDERS_DIR, undefined);
      const served = await send(world, { model: "auto/provider:z/opus", requestClass: "main" });
      expect(served.status, served.text).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([Z_OPUS_MODEL]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it.each(TRANSIENT)("answers a %s reading a provider's stored catalogue as retryable, never as the file's permissions to fix", async (code) => {
    let failing = true;
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { catalogueModelsOf: () => (failing ? raiseUnreadableCatalogue(code, errorWithCode(`${code}: failed`, code)) : [{ id: "glm-cat" }]) });
    try {
      world.setProvider("c", { displayName: "C", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "c-token" }] }, catalogue: { tier: "opus" } });
      const refused = await send(world, { model: "c", requestClass: "main" });
      expect(refused.status, refused.text).toBe(HTTP_STATUS.serviceUnavailable);
      expect(refused.text).not.toContain("permissions");
      failing = false;
      const served = await send(world, { model: "c", requestClass: "main" });
      expect(served.status, served.text).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-cat"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);
});
