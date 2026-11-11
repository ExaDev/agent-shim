import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { cosmiconfigReader, type ConfigFileReader } from "../config/load";
import { realFsPort } from "../realPorts";
import { fakeAsyncCredentials, fakeFs, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

const OWN_PORT = 4100;

/**
 * The reads of a configuration file one provider request makes through the door's configuration port, which reads without a cache: the provider's file, once when the request is scoped (whether the session's provider is defined) and once when its route is built. The models block, the catalogue and the identity records are read through the store and the farm's port, not this one. Two small reads a request is what the uncached port costs, so it stays uncached rather than gaining a cache that would have to be validated.
 */
const FILES_A_PROVIDER_REQUEST_READS = 2;

/** What a request that names an existing provider costs on top of that: one read of its file, which a port that can name a file's revision answers from its kept parse after the first. A name the providers directory does not list is answered by the listing and costs no read. */
const FILES_A_BARE_NAME_READS = 1;

describe("how many configuration files the door reads to resolve one request", () => {
  let providersDir: string;

  beforeEach(() => {
    providersDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-route-reads-"));
    fs.writeFileSync(path.join(providersDir, "z.json"), `${JSON.stringify({ displayName: "z.ai", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ literal: "placeholder" }], target: "apiKey" } })}\n`);
  });

  afterEach(() => {
    fs.rmSync(providersDir, { recursive: true, force: true });
  });

  function request(url: string, provider: string | undefined): RoutedRequest {
    return { method: "POST", url, headers: {}, body: Readable.from([Buffer.from("{}")]), signal: new AbortController().signal, session: { identity: "work", sessionId: "session", provider, headroom: false, projectId: undefined } };
  }

  function requestNaming(model: string): RoutedRequest {
    return { ...request("/v1/messages", undefined), body: Readable.from([Buffer.from(JSON.stringify({ model, max_tokens: 1, messages: [] }))]) };
  }

  /** The reads of each of `models`, asked in turn of one resolver over `fs`, as the count each request added. */
  async function readsPerModel(models: readonly string[], withRevisions: boolean, onListing: () => void = () => undefined, revisionOf: (file: string) => string | undefined = (file) => realFsPort.fileRevision?.(file)): Promise<readonly number[]> {
    let reads = 0;
    const real = cosmiconfigReader();
    const counting: ConfigFileReader = (file) => {
      reads += 1;
      return real(file);
    };
    const upstream = recordingFetch(() => new Response("{}", { status: 200 }));
    const resolve = createProviderRouteResolver({
      fs: { ...fakeFs({}), readConfigFile: counting, readdir: (dir) => { onListing(); return realFsPort.readdir(dir); }, fileRevision: withRevisions ? revisionOf : undefined },
      providersDir,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
      log: () => undefined,
      now: () => 0,
      mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
    });
    const counts: number[] = [];
    for (const model of models) {
      const before = reads;
      await resolve(requestNaming(model));
      counts.push(reads - before);
    }
    return counts;
  }

  /** Resolves `url` once with a reader that counts its loads, and returns the count. */
  async function readsFor(url: string, provider: string | undefined): Promise<number> {
    let reads = 0;
    const real = cosmiconfigReader();
    const counting: ConfigFileReader = (file) => {
      reads += 1;
      return real(file);
    };
    const upstream = recordingFetch(() => new Response("{}", { status: 200 }));
    const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0, mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      fs: { ...fakeFs({}), readConfigFile: counting, readdir: realFsPort.readdir },
      providersDir,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    await resolve(request(url, provider));
    return reads;
  }

  it("is two reads of the provider's file for a provider session's request, and none for one on the identity's own account", async () => {
    expect(await readsFor("/v1/messages", "z")).toBe(FILES_A_PROVIDER_REQUEST_READS);
    expect(await readsFor("/v1/messages", undefined)).toBe(0);
  });

  it("adds no read for a request naming a model that is no provider's or a bare Claude name (which no provider can be called), one for the first naming an existing provider, and none once its file has been parsed on a port that names revisions", async () => {
    expect(await readsPerModel(["claude-opus-4-7", "claude-opus-4-7"], false)).toEqual([0, 0]);
    expect(await readsPerModel(["some-model", "some-model"], false)).toEqual([0, 0]);
    const [first, second] = await readsPerModel(["z", "z"], true);
    // z names no tier model, so the request is refused before any route is built: the only read is the name lookup.
    expect(first).toBe(FILES_A_BARE_NAME_READS);
    expect(second).toBe(0);
  });

  it("keeps no parse of a provider file whose revision moved while it was read, and keeps the next one that did not", async () => {
    // The provider file's revision reads as r, then moved (after the first read), then r every time.
    const revisions = ["r", "moved"];
    const counts = await readsPerModel(["z", "z", "z"], true, () => undefined, (file) => (file.endsWith("z.json") ? (revisions.shift() ?? "r") : realFsPort.fileRevision?.(file)));
    expect(counts).toEqual([FILES_A_BARE_NAME_READS, FILES_A_BARE_NAME_READS, 0]);
  });

  it("lists the providers directory on every call when its revision cannot be taken, and still answers", async () => {
    let listings = 0;
    const counts = await readsPerModel(["z", "z"], true, () => { listings += 1; }, (file) => {
      if (file === providersDir) throw new Error("EACCES: permission denied");
      return realFsPort.fileRevision?.(file);
    });
    expect(counts).toEqual([FILES_A_BARE_NAME_READS, 0]);
    expect(listings).toBe(2);
  });

  it("reads a provider file on every call when its revision cannot be taken, and still answers", async () => {
    const counts = await readsPerModel(["z", "z"], true, () => undefined, (file) => {
      if (file.endsWith("z.json")) throw new Error("ELOOP: too many levels of symbolic links");
      return realFsPort.fileRevision?.(file);
    });
    expect(counts).toEqual([FILES_A_BARE_NAME_READS, FILES_A_BARE_NAME_READS]);
  });

  it("lists the providers directory afresh and keeps no listing when its revision moved while it was read", async () => {
    // The directory's revision reads r, then moved (after the first listing), then r every time.
    const revisions = ["r", "moved"];
    let listings = 0;
    const counts = await readsPerModel(["z", "z", "z"], true, () => { listings += 1; }, (file) => (file === providersDir ? (revisions.shift() ?? "r") : realFsPort.fileRevision?.(file)));
    expect(counts[0]).toBe(FILES_A_BARE_NAME_READS);
    // The first listing was not kept, so the second lookup listed again; the third used the kept one.
    expect(listings).toBe(2);
  });

  it("lists the providers directory once while its revision is unchanged, however many names are asked, and once more after a file is added", async () => {
    const names = ["some-model", "other-model", "some-model"];
    let withRevisions = 0;
    expect(await readsPerModel(names, true, () => { withRevisions += 1; })).toEqual([0, 0, 0]);
    expect(withRevisions).toBe(1);
    let withoutRevisions = 0;
    await readsPerModel(names, false, () => { withoutRevisions += 1; });
    expect(withoutRevisions).toBe(names.length);
  });

  it("sees a provider file added after the directory was listed, and stops matching its name once the file is deleted", async () => {
    const file = path.join(providersDir, "late.json");
    const upstream = recordingFetch(() => new Response("{}", { status: 200 }));
    const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0, mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      fs: { ...fakeFs({}), readConfigFile: cosmiconfigReader(), readdir: realFsPort.readdir, fileRevision: realFsPort.fileRevision },
      providersDir,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    const routeOf = async (): Promise<string> => {
      const resolution = await resolve(requestNaming("late"));
      if (!resolution.ok) throw new Error(resolution.message);
      return resolution.route.name;
    };
    expect(await routeOf()).toBe("anthropic");
    fs.writeFileSync(file, `${JSON.stringify({ displayName: "late", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ literal: "placeholder" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "m" } })}\n`);
    expect(await routeOf()).toBe("http:late");
    fs.rmSync(file);
    expect(await routeOf()).toBe("anthropic");
  });

  it("sees a same-size rewrite of a provider file, and stops matching its name once the file is deleted", async () => {
    const file = path.join(providersDir, "w.json");
    const write = (model: string): void => {
      fs.writeFileSync(file, `${JSON.stringify({ displayName: "w", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ literal: "placeholder" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: model } })}\n`);
    };
    const upstream = recordingFetch(() => new Response("{}", { status: 200 }));
    const resolve = createProviderRouteResolver({
      log: () => undefined,
      now: () => 0,
      mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      fs: { ...fakeFs({}), readConfigFile: cosmiconfigReader(), readdir: realFsPort.readdir, fileRevision: realFsPort.fileRevision },
      providersDir,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    const modelSent = async (): Promise<string | undefined> => {
      const resolution = await resolve(requestNaming("w"));
      if (!resolution.ok) throw new Error(resolution.message);
      if (resolution.route.name !== "http:w") return undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of resolution.request?.body ?? []) chunks.push(Buffer.from(chunk as Uint8Array));
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return typeof parsed === "object" && parsed !== null && "model" in parsed && typeof parsed.model === "string" ? parsed.model : undefined;
    };
    write("one");
    expect(await modelSent()).toBe("one");
    write("two");
    expect(await modelSent()).toBe("two");
    fs.rmSync(file);
    expect(await modelSent()).toBeUndefined();
  });
});
