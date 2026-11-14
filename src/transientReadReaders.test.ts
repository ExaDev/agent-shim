import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIdentityNameReader } from "./identityStore";
import { buildLayoutPaths } from "./paths";
import { listProviderNames, listProviders } from "./providersStore";
import { raiseUnreadableCatalogue, skipUnreadableCatalogueUnlessTransient, TolerantReader, UnreadableCatalogueError } from "./storedCatalogue";
import { createMainLoopRouteRecord } from "./frontdoor/mainLoopRoute";
import { readFrontDoorCodexRecord, readFrontDoorState } from "./frontdoor/state";
import { errorWithCode } from "./test-helpers";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A state root with identity `work` (id `work`) and provider `z`. */
function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transient-readers-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
  fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "z.json"), JSON.stringify({ displayName: "Z", baseUrl: "https://z.invalid", credential: { sources: [{ env: "Z" }] } }));
  return paths;
}

/** Makes `fs.readFileSync` throw `code` for `file` while `failing()` holds; every other read goes to the real file system. The readers under test read text (`readFileSync(path, "utf8")`), the one form this answers. */
function failReads(file: string, code: string, failing: () => boolean): void {
  const real = fs.readFileSync.bind(fs);
  const failingRead = (target: fs.PathOrFileDescriptor, encoding: BufferEncoding): string => {
    if (failing() && target === file) throw errorWithCode(`${code}: failed, open '${file}'`, code);
    return real(target, encoding);
  };
  // `readFileSync` is overloaded and a mock must take its whole type, which no one-signature function has; the readers under test call the text form only.
  vi.spyOn(fs, "readFileSync").mockImplementation(failingRead as typeof fs.readFileSync);
}

describe("each local-file reader on a read that fails for the moment", () => {
  it("has the stored catalogue reader that answers for the file keep the code of a failure of the moment, and none of one of the file's own", () => {
    const reading = (code: string) => new TolerantReader(() => { throw errorWithCode(`${code}: failed`, code); }, raiseUnreadableCatalogue);
    let transient: unknown;
    try { reading("EMFILE").read("/catalogue.json"); } catch (error) { transient = error; }
    let own: unknown;
    try { reading("EACCES").read("/catalogue.json"); } catch (error) { own = error; }
    expect(transient).toBeInstanceOf(UnreadableCatalogueError);
    expect(transient instanceof UnreadableCatalogueError ? transient.code : "none").toBe("EMFILE");
    expect(own instanceof UnreadableCatalogueError ? own.code : "none").toBeUndefined();
  });

  it("has the identity name reader throw an EMFILE on identity.json as it is, never as the identity's file fault, and name the identity once it reads", () => {
    const paths = layout();
    let failing = true;
    failReads(path.join(paths.identitiesDir, "work", "identity.json"), "EMFILE", () => failing);
    const reader = createIdentityNameReader(paths);
    let thrown: unknown;
    try { reader.requireNameOf("work"); } catch (error) { thrown = error; }
    // The system's own error, not the identity's file fault, which names the identity id and a code too.
    expect(thrown).toMatchObject({ code: "EMFILE", name: "Error" });
    failing = false;
    expect(reader.requireNameOf("work")).toBe("work");
  });

  it("has the providers listing throw an EMFILE rather than answer that there are no providers", () => {
    expect(() => listProviderNames(() => { throw errorWithCode("EMFILE: too many open files", "EMFILE"); }, "/providers")).toThrow(/EMFILE/u);
    expect(listProviderNames(() => { throw errorWithCode("ENOENT: no such directory", "ENOENT"); }, "/providers")).toEqual([]);
  });

  it("has listProviders throw an EMFILE on a provider file rather than report the provider invalid", () => {
    const paths = layout();
    failReads(path.join(paths.providersDir, "z.json"), "EMFILE", () => true);
    const invalid: string[] = [];
    expect(() => listProviders(paths, (name) => { invalid.push(name); })).toThrow(/EMFILE/u);
    expect(invalid).toEqual([]);
  });
});

describe("the request path's other local-file readers on a read that fails for the moment", () => {
  it("has a provider's stored catalogue read for the targets passed on, never read as no catalogue, while a file with a fault of its own is still skipped", () => {
    const skip = (code: string): unknown => {
      try {
        skipUnreadableCatalogueUnlessTransient(code, errorWithCode(`${code}: failed`, code));
        return "skipped";
      } catch (error) {
        return error;
      }
    };
    expect(skip("EACCES")).toBe("skipped");
    expect(skip("EMFILE")).toMatchObject({ code: "EMFILE" });
  });

  it("has the door's state file passed on to a reader on the request path, and read as no door elsewhere", () => {
    const reading = { readFileUtf8: (): string => { throw errorWithCode("EMFILE: too many open files", "EMFILE"); } };
    expect(readFrontDoorState(reading, "/state/frontdoor/state.json")).toBeUndefined();
    expect(() => readFrontDoorState(reading, "/state/frontdoor/state.json", true)).toThrow(/EMFILE/u);
    expect(readFrontDoorCodexRecord(reading, "/state/frontdoor", 1)).toBeUndefined();
    expect(() => readFrontDoorCodexRecord(reading, "/state/frontdoor", 1, true)).toThrow(/EMFILE/u);
  });

  it("has the route context's copy passed on and nothing kept, so the next lookup reads it again", () => {
    let failing = true;
    let reads = 0;
    const record = createMainLoopRouteRecord({
      holdsLaunch: () => true,
      stored: { read: () => { reads += 1; if (failing) throw errorWithCode("EMFILE: too many open files", "EMFILE"); return { kind: "provider", provider: "z" }; }, write: () => undefined, identity: () => "rev-1" },
      log: () => undefined,
    });
    const launch = { pid: 4242, startedAt: 1 };
    expect(() => record.routeOf(launch)).toThrow(/EMFILE/u);
    failing = false;
    expect(record.routeOf(launch)).toMatchObject({ kind: "provider", provider: "z" });
    expect(reads).toBe(2);
  });
});
