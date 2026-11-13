import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { UsageError } from "./cliError";
import { buildLayoutPaths } from "./paths";
import { createRouteOverridesReader, isOverrideKey, NO_ROUTE_OVERRIDES, overrideFor, overrideMatches, readRouteOverrides, routeOverridesRenamed, withRouteOverride, writeRouteOverrides } from "./routeOverridesStore";
import type { RouteOverrides } from "./routeOverridesSchema";

const FILE = "/state/route-overrides.json";

/** A file system over one file whose text and revision a test sets, counting reads and stats. */
function oneFile(initial: { text?: string; revision?: string; readError?: Error }) {
  const state = { ...initial, reads: 0, stats: 0, onStat: undefined as (() => void) | undefined };
  return {
    state,
    fs: {
      fileRevision: (file: string) => {
        state.stats += 1;
        state.onStat?.();
        return file === FILE ? state.revision : undefined;
      },
      readFileUtf8: (file: string) => {
        state.reads += 1;
        if (state.readError !== undefined) throw state.readError;
        return file === FILE ? state.text : undefined;
      },
    },
  };
}

const TABLE: RouteOverrides = { schemaVersion: 1, global: { opus: "z/a" } };
/** How many lookups a test makes of one revision: more than one, so a read per lookup would show. */
const LOOKUPS = 4;

/** An error as the file system raises one for a read it may not make. */
function permissionDenied(): Error {
  const error: Error & { code?: string } = new Error("EACCES: permission denied, open '/state/route-overrides.json'");
  error.code = "EACCES";
  return error;
}

describe("the overrides reader", () => {
  it("reads nothing while the file does not exist", () => {
    const { fs, state } = oneFile({});
    const read = createRouteOverridesReader(fs, FILE, () => undefined);
    expect(read()).toEqual({ table: NO_ROUTE_OVERRIDES });
    expect(read()).toEqual({ table: NO_ROUTE_OVERRIDES });
    expect(state.reads).toBe(0);
  });

  it("reads once per revision", () => {
    const { fs, state } = oneFile({ text: JSON.stringify(TABLE), revision: "r1" });
    const read = createRouteOverridesReader(fs, FILE, () => undefined);
    for (let index = 0; index < LOOKUPS; index += 1) expect(read()).toEqual({ table: TABLE });
    expect(state.reads).toBe(1);
    state.revision = "r2";
    state.text = JSON.stringify({ schemaVersion: 1 });
    expect(read()).toEqual({ table: { schemaVersion: 1 } });
    expect(read()).toEqual({ table: { schemaVersion: 1 } });
    expect(state.reads).toBe(2);
  });

  it("does not keep a read that raced a write: the revision after differs, so the next request reads again", () => {
    const { fs, state } = oneFile({ text: JSON.stringify(TABLE), revision: "r1" });
    const read = createRouteOverridesReader(fs, FILE, () => undefined);
    // The stat after the read sees a new revision, as a write landing during the read makes it.
    state.onStat = () => {
      if (state.reads === 1 && state.stats === 2) state.revision = "r2";
    };
    read();
    state.onStat = undefined;
    read();
    expect(state.reads).toBe(2);
    read();
    expect(state.reads).toBe(2);
  });

  it.each<[string, { text?: string; readError?: Error }, string]>([
    ["not JSON", { text: "{" }, "not JSON"],
    ["another shape", { text: JSON.stringify({ schemaVersion: 1, global: { opus: 5 } }) }, "global.opus"],
    ["a newer release's file", { text: JSON.stringify({ schemaVersion: 2 }) }, "schemaVersion"],
    ["unreadable", { readError: permissionDenied() }, "(EACCES)"],
  ])("reports a file that is %s as a fault naming no path, logged once per revision", (_label, file, fragment) => {
    const { fs } = oneFile({ ...file, revision: "r1" });
    const lines: string[] = [];
    const read = createRouteOverridesReader(fs, FILE, (line) => {
      lines.push(line);
    });
    const first = read();
    read();
    expect("fault" in first && first.fault).toContain(fragment);
    expect(JSON.stringify(first)).not.toContain("/state/");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("/state/");
  });
});

describe("which override applies", () => {
  const overrides: RouteOverrides = {
    schemaVersion: 1,
    global: { opus: "g/class", "claude-opus-5-5": "g/exact" },
    providers: { z: { opus: "p/class" } },
    identities: { me: { "claude-opus-5-5": "i/exact" } },
    sessions: { s: { sonnet: "s/class" } },
  };

  it.each<[string, Record<string, string>, string | undefined]>([
    ["claude-opus-5-5", {}, "g/exact"],
    ["claude-opus-5-1", {}, "g/class"],
    ["opus", {}, "g/class"],
    ["claude-opus-5-5[1m]", {}, "g/exact"],
    ["claude-opus-5-5", { provider: "z" }, "p/class"],
    ["claude-opus-5-5", { provider: "z", identity: "me" }, "i/exact"],
    ["claude-sonnet-5-5", { sessionId: "s", identity: "me", provider: "z" }, "s/class"],
    ["claude-haiku-5-5", { sessionId: "s", identity: "me", provider: "z" }, undefined],
    ["z/claude-opus-5-5", {}, undefined],
    ["magnum-opus", {}, undefined],
  ])("routes %j for %j by %j", (model, ids, target) => {
    expect(overrideFor(overrides, ids, model)?.target).toBe(target);
  });

  it("lists what the winner outranks, in precedence order", () => {
    expect(overrideMatches(overrides, { identity: "me", provider: "z" }, "claude-opus-5-5").map((match) => `${match.scope.kind}:${match.match}:${match.target}`)).toEqual(["identity:exact:i/exact", "provider:class:p/class", "global:exact:g/exact", "global:class:g/class"]);
  });
});

describe("setting and removing one entry", () => {
  it("sets, replaces and removes, leaving no empty table or scope", () => {
    const set = withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "identity", name: "me" }, "opus", "z/a");
    expect(set).toEqual({ schemaVersion: 1, identities: { me: { opus: "z/a" } } });
    const replaced = withRouteOverride(set, { kind: "identity", name: "me" }, "opus", "z/b");
    expect(replaced).toEqual({ schemaVersion: 1, identities: { me: { opus: "z/b" } } });
    expect(withRouteOverride(replaced, { kind: "identity", name: "me" }, "opus", undefined)).toEqual({ schemaVersion: 1 });
    expect(withRouteOverride(withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, "haiku", "z/h"), { kind: "global" }, "haiku", undefined)).toEqual({ schemaVersion: 1 });
  });

  it.each(["z/opus", "opus[1m]", "glm-5", "", "auto"])("refuses %j as a key", (key) => {
    expect(isOverrideKey(key)).toBe(false);
    expect(() => withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, key, "z/a")).toThrow(UsageError);
  });

  it("refuses the bare target auto and removing an entry that is not set", () => {
    expect(() => withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, "opus", "auto")).toThrow(/z|<provider>\/auto/);
    expect(() => withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, "opus", undefined)).toThrow(/No override/);
  });
});

describe("renaming what the overrides name", () => {
  const overrides: RouteOverrides = {
    schemaVersion: 1,
    global: { opus: "acct:work/opus", sonnet: "auto/work/sonnet", haiku: "auto/identity:work", fable: "auto/provider:work/x", "claude-opus-5-5": "z/glm", "claude-opus-5-1": "z", "claude-haiku-5-5": "auto/pool:z" },
    identities: { work: { opus: "z/a" }, client: { haiku: "z/b" } },
    providers: { z: { opus: "acct:work/opus" } },
  };

  it("moves an identity's scope (its entries outranking what the new name held) and rewrites the targets naming it", () => {
    const renamed = withRouteOverride(withRouteOverride(overrides, { kind: "identity", name: "client" }, "opus", "z/old"), { kind: "global" }, "opus", "acct:work/opus");
    const result = routeOverridesRenamed(renamed, "identity", "work", "client");
    expect(result?.value.global).toEqual({ ...overrides.global, opus: "acct:client/opus", sonnet: "auto/client/sonnet", haiku: "auto/identity:client" });
    expect(result?.value.identities).toEqual({ client: { haiku: "z/b", opus: "z/a" } });
    expect(result?.value.providers).toEqual({ z: { opus: "acct:client/opus" } });
    expect(result?.changes).toEqual(["global", "providers z", "identities work -> client"]);
  });

  it("moves a provider's scope and rewrites provider models, bare provider names and provider selectors, leaving other kinds' selectors", () => {
    const result = routeOverridesRenamed(overrides, "provider", "z", "y");
    expect(result?.value.global).toEqual({ ...overrides.global, "claude-opus-5-5": "y/glm", "claude-opus-5-1": "y" });
    expect(result?.value.identities).toEqual({ work: { opus: "y/a" }, client: { haiku: "y/b" } });
    expect(result?.value.providers).toEqual({ y: { opus: "acct:work/opus" } });
  });

  it("reports nothing when nothing names the old name", () => {
    expect(routeOverridesRenamed(overrides, "identity", "nobody", "else")).toBeUndefined();
  });
});

describe("the store's edges", () => {
  it("keeps a $schema pointer across a change, and drops an emptied global table", () => {
    const withSchema: RouteOverrides = { $schema: "./schema/RouteOverrides.schema.json", schemaVersion: 1, global: { opus: "z/a" } };
    expect(withRouteOverride(withSchema, { kind: "global" }, "opus", undefined)).toEqual({ $schema: "./schema/RouteOverrides.schema.json", schemaVersion: 1 });
  });

  it("names the scope in a refusal", () => {
    expect(() => withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, "opus", undefined)).toThrow('No override of "opus" is set globally.');
    expect(() => withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "identity", name: "work" }, "opus", undefined)).toThrow('No override of "opus" is set for identity "work".');
  });

  it("logs nothing for a file it can use", () => {
    const lines: string[] = [];
    const read = createRouteOverridesReader({ fileRevision: () => "r1", readFileUtf8: () => JSON.stringify(TABLE) }, FILE, (line) => {
      lines.push(line);
    });
    read();
    expect(lines).toEqual([]);
  });

  it("adds no global table when renaming in a file that has none", () => {
    expect(routeOverridesRenamed({ schemaVersion: 1, identities: { work: { opus: "z/a" } } }, "identity", "work", "client")?.value).toEqual({ schemaVersion: 1, identities: { client: { opus: "z/a" } } });
  });
});

describe("a damaged overrides file is never read as no overrides", () => {
  /** What the headroom precedent's reader does with a file it cannot stat: no setting. This reader must not. */
  it.each<[string, Parameters<typeof createRouteOverridesReader>[0]]>([
    ["a file whose stat fails", { fileRevision: () => { throw permissionDenied(); }, readFileUtf8: () => { throw permissionDenied(); } }],
    ["a file that cannot be read", { fileRevision: () => "r1", readFileUtf8: () => { throw permissionDenied(); } }],
    ["a file that is not JSON", { fileRevision: () => "r1", readFileUtf8: () => "{" }],
    ["a file of another shape", { fileRevision: () => "r1", readFileUtf8: () => JSON.stringify({ schemaVersion: 1, sessions: [] }) }],
    ["an empty file", { fileRevision: () => "r1", readFileUtf8: () => "" }],
  ])("reports %s as a fault and gives no table", (_label, fs) => {
    const read = createRouteOverridesReader(fs, FILE, () => undefined)();
    expect(read).not.toHaveProperty("table");
    expect(read).toHaveProperty("fault");
  });
});

describe("every write leaves a file the reader can use", () => {
  it.each<[string, RouteOverrides]>([
    ["an empty scope name", { schemaVersion: 1, sessions: { "": { opus: "z/a" } } }],
    ["an empty target", { schemaVersion: 1, global: { opus: "" } }],
  ])("refuses to set an entry that would leave %s", (_label, overrides) => {
    const [scopeKey] = Object.keys(overrides).filter((key) => key !== "schemaVersion");
    const scope = scopeKey === "sessions" ? ({ kind: "session", name: "" } as const) : ({ kind: "global" } as const);
    const target = scopeKey === "sessions" ? "z/a" : "";
    expect(() => withRouteOverride(NO_ROUTE_OVERRIDES, scope, "opus", target)).toThrow(UsageError);
  });
});

describe("the one writer of the overrides file", () => {
  it("refuses to write overrides the readers would refuse, leaving the file as it was", () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "route-overrides-write-"));
    try {
      const paths = buildLayoutPaths(root);
      writeRouteOverrides(paths, TABLE);
      expect(() => {
        writeRouteOverrides(paths, { schemaVersion: 1, sessions: { "": { opus: "z/a" } } });
      }).toThrow(UsageError);
      expect(readRouteOverrides(paths)).toEqual(TABLE);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is the only code that writes the file: every other module goes through it or through a step that checks the same schema", () => {
    const sources = (directory: string): readonly string[] =>
      nodeFs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        return entry.isDirectory() ? sources(full) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
      });
    const naming = sources(path.join(__dirname)).filter((file) => nodeFs.readFileSync(file, "utf8").includes("routeOverridesFile"));
    const writers = naming.filter((file) => /routeOverridesFile[^\n]*(?:writeJsonAtomic|writeTextAtomic|writeFile)|(?:writeJsonAtomic|writeTextAtomic|writeFile)[^\n]*routeOverridesFile/.test(nodeFs.readFileSync(file, "utf8")));
    expect(writers.map((file) => path.relative(__dirname, file)).sort()).toEqual(["routeOverridesStore.ts"]);
    // The identity rename's step writes it through `jsonRewriteStep`, which validates against the schema it is given: the readers' own.
    expect(nodeFs.readFileSync(path.join(__dirname, "identityRenameSteps.ts"), "utf8")).toContain("jsonRewriteStep(paths, ports, paths.routeOverridesFile, RouteOverridesSchema,");
  });
});

describe("a key in any case is the lower-case key", () => {
  it("stores a key as its lower-case spelling", () => {
    expect(withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, "OPUS", "z/a")).toEqual({ schemaVersion: 1, global: { opus: "z/a" } });
    expect(withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, "Claude-Opus-5-5", "z/a")).toEqual({ schemaVersion: 1, global: { "claude-opus-5-5": "z/a" } });
  });

  it("removes an entry a hand edit wrote in another case by its lower-case spelling", () => {
    expect(withRouteOverride({ schemaVersion: 1, global: { OPUS: "z/a", haiku: "z/h" } }, { kind: "global" }, "opus", undefined)).toEqual({ schemaVersion: 1, global: { haiku: "z/h" } });
  });

  it("refuses a file with two keys of one table that differ only in case, since which was meant cannot be told", () => {
    const read = createRouteOverridesReader({ fileRevision: () => "r1", readFileUtf8: () => JSON.stringify({ schemaVersion: 1, global: { opus: "z/a", OPUS: "z/b" } }) }, FILE, () => undefined)();
    expect("fault" in read ? read.fault : "").toContain("differ only in case");
  });

  it("matches a key a hand edit wrote in another case, as the reader reads it", () => {
    const read = createRouteOverridesReader({ fileRevision: () => "r1", readFileUtf8: () => JSON.stringify({ schemaVersion: 1, global: { OPUS: "z/a" }, identities: { work: { "CLAUDE-HAIKU-5-5": "z/h" } } }) }, FILE, () => undefined)();
    expect("table" in read ? overrideFor(read.table, { identity: "work" }, "claude-opus-5-5")?.target : undefined).toBe("z/a");
    expect("table" in read ? overrideFor(read.table, { identity: "work" }, "Claude-Haiku-5-5")?.target : undefined).toBe("z/h");
  });
});
