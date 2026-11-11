import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { followingMainLoop } from "./mainLoopRoute";
import { HAIKU_NAME, LIVE_SERVED_MODEL, launchOfSession, send, startWorld } from "./mainLoopRouteTestWorld";
import type { RouteResolution, ServedModelReport } from "./pipeline";
import type { RoutedRequest } from "./route";

/** A resolver whose answer for each request is the resolution it was told to give, each carrying a report channel the test fires by hand. */
function stagedResolver(): { readonly resolve: (request: RoutedRequest) => Promise<RouteResolution>; readonly reports: ServedModelReport[]; readonly next: (provider: string, model: string | undefined, requested: string, hold?: Promise<void>) => void } {
  const queue: { provider: string; model: string | undefined; requested: string; hold: Promise<void> | undefined }[] = [];
  const reports: ServedModelReport[] = [];
  return {
    reports,
    next: (provider, model, requested, hold) => {
      queue.push({ provider, model, requested, hold });
    },
    resolve: async (request) => {
      const step = queue.shift();
      if (step === undefined) throw new Error("no resolution staged");
      // A request whose body arrives slowly is resolved late: it started first and finishes last.
      await step.hold;
      const report: ServedModelReport = {};
      reports.push(report);
      const served: RoutedRequest = { ...request, url: `/providers/${step.provider}${request.url}` };
      return await Promise.resolve({ ok: true, route: { name: `http:${step.provider}`, headroomEligible: false, headroomUpstream: undefined, serve: async () => { await Promise.resolve(); } }, request: served, requestedModel: step.requested, ...(step.model === undefined ? {} : { servedModel: step.model }), servedModelReport: report });
    },
  };
}

function requestOf(session: string): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from([Buffer.from("{}")]), signal: new AbortController().signal, session: { identity: undefined, sessionId: session, provider: undefined, headroom: false, projectId: undefined, launch: launchOfSession(session) } };
}

describe("a late report of the model a route sent", () => {
  const wrap = (resolve: (request: RoutedRequest) => Promise<RouteResolution>, record = mainLoopRoutesOfLiveSessions()): { readonly follow: (request: RoutedRequest) => Promise<RouteResolution>; readonly record: ReturnType<typeof mainLoopRoutesOfLiveSessions> } => ({
    follow: followingMainLoop(resolve, { record, providerMapping: () => ({ model: { kind: "as-is" }, credential: undefined }), loginOf: () => "login", definesProvider: () => false }),
    record,
  });

  it("does not put the launch back on an earlier request's route once a later request has recorded its own", async () => {
    const staged = stagedResolver();
    const { follow, record } = wrap(staged.resolve);
    staged.next("spark", "auto", "spark/auto");
    await follow(requestOf("s-1"));
    staged.next("other", "m", "other/m");
    await follow(requestOf("s-1"));
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ kind: "provider", provider: "other", servedModel: "m" });
    // The first request's wrapper only now learns which model it sent.
    staged.reports[0]?.listener?.("m1");
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ kind: "provider", provider: "other", servedModel: "m" });
  });

  it("does not let a request that started first and finished last overwrite the context of one that started after it", async () => {
    const staged = stagedResolver();
    const { follow, record } = wrap(staged.resolve);
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    staged.next("spark", "slow-m", "spark/slow", slow);
    staged.next("spark", "fast-m", "spark/fast");
    const first = follow(requestOf("s-1"));
    await follow(requestOf("s-1"));
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ requestedModel: "spark/fast", servedModel: "fast-m" });
    release();
    await first;
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ requestedModel: "spark/fast", servedModel: "fast-m" });
  });

  it("is applied while its request is still the launch's latest, once for each report it makes", async () => {
    const staged = stagedResolver();
    const { follow, record } = wrap(staged.resolve);
    staged.next("spark", "auto", "spark/auto");
    await follow(requestOf("s-1"));
    staged.reports[0]?.listener?.("m1");
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ provider: "spark", servedModel: "m1" });
    staged.reports[0]?.listener?.("m2");
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ provider: "spark", servedModel: "m2" });
  });

  it("keeps each session's own context when two sessions use one provider", async () => {
    const staged = stagedResolver();
    const { follow, record } = wrap(staged.resolve);
    staged.next("spark", "auto", "spark/auto");
    await follow(requestOf("s-1"));
    staged.next("spark", "auto", "spark/auto");
    await follow(requestOf("s-2"));
    staged.reports[0]?.listener?.("for-one");
    staged.reports[1]?.listener?.("for-two");
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ provider: "spark", servedModel: "for-one" });
    expect(record.routeOf(launchOfSession("s-2"))).toMatchObject({ provider: "spark", servedModel: "for-two" });
  });
});

describe("what a main-loop request records, for every way it can reach an http provider", () => {
  /** The ways a request ends on provider spark that sends a model through the editing wrapper, each with the model name it sends and what the wrapper then reports. */
  const KINDS: readonly (readonly [string, (world: Awaited<ReturnType<typeof startWorld>>) => Promise<void>, string])[] = [
    ["a qualified name", async (world) => { await send(world, { model: "z/auto", requestClass: "main" }); }, "z/auto"],
    ["a bare provider name whose tier is auto", async (world) => { await send(world, { model: "z", requestClass: "main" }); }, "z"],
    ["a bare Claude name on a provider context whose tier value is auto", async (world) => { await send(world, { model: "z/auto", requestClass: "main" }); await send(world, { model: HAIKU_NAME, requestClass: "main" }); }, HAIKU_NAME],
  ];

  it.each(KINDS)("records the model the upstream finally received: %s", async (_label, drive, requested) => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record);
    try {
      world.setProvider("z", { displayName: "Z", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "auto", ANTHROPIC_DEFAULT_SONNET_MODEL: "auto", ANTHROPIC_DEFAULT_OPUS_MODEL: "auto" } });
      world.upstream.serveOnly(LIVE_SERVED_MODEL);
      await drive(world);
      const sent = world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model);
      expect(sent.at(-1)).toBe(LIVE_SERVED_MODEL);
      expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ provider: "z", requestedModel: requested, servedModel: LIVE_SERVED_MODEL });
    } finally {
      await world.close();
    }
  });
});

/**
 * The places `followingMainLoop` uses its `deps` other than as `deps.<member>`: any identifier `deps` whose parent is not a property access (or a string-literal element access) on it, which is a copy, an alias, a spread, a destructuring or a call that hands `deps` on, and any use of `deps.record` other than `.routeOf` and `.begin`, outside the one top-level `recordServing`. Read from the syntax tree, so a spelling a text search would miss is a finding too. `recordServing` counts only as the variable declared in the body of `followingMainLoop` itself, never one nested in another function.
 */
function depsUsesOutsideRecordServing(sourceText: string): readonly string[] {
  const file = ts.createSourceFile("mainLoopRoute.ts", sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const memberName = (node: ts.Node): string | undefined => (ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined);
  const isDepsIdentifier = (node: ts.Node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "deps";
  const topLevelRecordServing = (node: ts.Node): boolean => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "recordServing") return false;
    // variable declaration -> list -> statement -> block of the function that holds it
    const holder = node.parent.parent.parent;
    return ts.isBlock(holder) && ts.isFunctionDeclaration(holder.parent) && holder.parent.name?.text === "followingMainLoop";
  };
  const visit = (node: ts.Node): void => {
    if (topLevelRecordServing(node)) return;
    if (isDepsIdentifier(node) && !ts.isParameter(node.parent) && !(ts.isPropertySignature(node.parent))) {
      const parent = node.parent;
      const member = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node ? memberName(parent) : undefined;
      if (member === undefined) {
        found.push(parent.getText(file));
      } else if (member === "record") {
        const use = parent.parent;
        const readsAllowed = (ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use)) && use.expression === parent && (memberName(use) === "routeOf" || memberName(use) === "begin");
        if (!readsAllowed) found.push(use.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the one place a main-loop request's context is recorded", () => {
  const OPEN = "export function followingMainLoop(deps: Deps) {\n  const recordServing = () => {\n    deps.record.record(launch, context, ticket);\n  };\n";
  const around = (line: string): string => `${OPEN}  const other = () => {\n    ${line}\n  };\n}`;

  it("is `recordServing`: followingMainLoop uses its deps nowhere else in a way that could reach the record, so none can serve a model through the wrapper with no report wired", () => {
    const source = fs.readFileSync(path.join(__dirname, "mainLoopRoute.ts"), "utf8");
    expect(source).toContain("const recordServing = ");
    expect(depsUsesOutsideRecordServing(source)).toEqual([]);
  });

  it.each([
    ["a direct call", "deps.record.record(launch, context);"],
    ["an optional call", "deps.record?.record(launch, context);"],
    ["bracket access to the record", 'deps["record"].record(launch, context);'],
    ["bracket access to the method", 'deps.record["record"](launch, context);'],
    ["a call through call", "deps.record.record.call(deps.record, launch, context);"],
    ["an alias of the record", "const rec = deps.record; rec.record(launch, context);"],
    ["a destructuring of the record", "const { record } = deps; record.record(launch, context);"],
    ["an alias of deps", "const d = deps; d.record.record(launch, context);"],
    ["a spread of deps", "const copy = { ...deps }; copy.record.record(launch, context);"],
    ["a computed destructuring", 'const { ["record"]: r } = deps; r.record(launch, context);'],
    ["deps handed to a function", "helper(deps);"],
    ["deps returned from a function", "return deps;"],
  ])("finds %s outside recordServing", (_label, line) => {
    expect(depsUsesOutsideRecordServing(around(line)).length).toBeGreaterThan(0);
  });

  it("finds a recordServing declared inside another function, which is no exemption", () => {
    const nested = `export function followingMainLoop(deps: Deps) {\n  const other = () => {\n    const recordServing = () => {\n      deps.record.record(launch, context);\n    };\n  };\n}`;
    expect(depsUsesOutsideRecordServing(nested).length).toBeGreaterThan(0);
  });

  it("leaves routeOf and begin, the other members of deps and the top-level recordServing alone", () => {
    expect(depsUsesOutsideRecordServing(around("const current = deps.record.routeOf(launch);\n    const ticket = deps.record.begin(launch);\n    const login = deps.loginOf(session);"))).toEqual([]);
  });
});
