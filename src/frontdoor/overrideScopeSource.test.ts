import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { sessionRouteProvider } from "./mainLoopRoute";

/** The door's modules a renaming or a route decision is made in. */
const DOOR_MODULES = ["mainLoopRoute.ts", "providerRoute.ts"];

/** Every line of `text`, with comments left out. */
function codeLines(text: string): readonly string[] {
  return text.split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*\*)/u.test(line));
}

describe("where an override's scope and a selector's route come from", () => {
  it.each<[string, string | undefined, Parameters<typeof sessionRouteProvider>[1], string | undefined]>([
    ["a session launched on a provider, whatever its context", "m", { kind: "provider", provider: "z", movedBy: "override" }, "m"],
    ["a session the person moved to a provider", undefined, { kind: "provider", provider: "z" }, "z"],
    ["a session an override moved to a provider", undefined, { kind: "provider", provider: "z", movedBy: "override" }, undefined],
    ["a session an override moved off the provider the person chose", undefined, { kind: "anthropic", movedBy: "override", chosenProvider: "z" }, "z"],
    ["a session an override moved from one provider the person chose to another", undefined, { kind: "provider", provider: "m", movedBy: "override", chosenProvider: "z" }, "z"],
    ["a session on the Anthropic route", undefined, { kind: "anthropic" }, undefined],
    ["a session with no context", undefined, undefined, undefined],
  ])("is the session's own route for %s", (_label, launchProvider, context, expected) => {
    expect(sessionRouteProvider(launchProvider, context)).toBe(expected);
  });

  it("is read from the recorded context only through sessionRouteProvider, so no override decides the scope of the next", () => {
    for (const module of DOOR_MODULES) {
      const lines = codeLines(fs.readFileSync(path.join(__dirname, module), "utf8"));
      // Every place a renaming is told the session's route builds it from sessionRouteProvider.
      for (const line of lines.filter((candidate) => /\brouteProvider\s*:/u.test(candidate) && !candidate.includes('readonly routeProvider') && !candidate.includes('routeProvider: context.routeProvider'))) {
        expect(line, `${module}: ${line.trim()}`).toContain("sessionRouteProvider(");
      }
    }
    // The recorded context is read in two places: as the argument of sessionRouteProvider, and as the route the main loop's helpers follow (`current`), which an override's move rightly sets.
    const reads = DOOR_MODULES.flatMap((module) => codeLines(fs.readFileSync(path.join(__dirname, module), "utf8")).filter((line) => line.includes(".routeOf(")).map((line) => `${module}: ${line.trim()}`));
    expect(reads).toHaveLength(2);
    expect(reads.filter((read) => read.includes("sessionRouteProvider("))).toHaveLength(1);
    expect(reads.filter((read) => read.includes('const current = deps.record.routeOf(launch);'))).toHaveLength(1);
  });
});
