import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ownEntry } from "./ownEntry";

/** The modules that look a record up by a name a person or a client chose (a model, a selector's word, a pool, a scope): each such lookup goes through `ownEntry`. */
const NAMED_LOOKUP_MODULES = ["models/selectors.ts", "models/selectorPorts.ts", "routeOverridesStore.ts", "routeOverrideChecks.ts", "routeOverrides.ts", "modelsStore.ts", "frontdoor/providerRoute.ts", "models.ts"];

/** A computed property read with a variable key, the spelling that answers an inherited name with `Object.prototype`'s member: `x?.[key]`, `)[key]`, and `name[key]` where `key` is an identifier (a literal or a numeric index is no chosen name). */
const RAW_COMPUTED_READ = /(?:\?\.|\)|[A-Za-z_$][\w$]*)\[(?!["'`\d])[A-Za-z_$][\w$.]*\](?!\s*=[^=])/g;

/** The reads that are not by a chosen name, exactly as written: an index into an array, a map of fixed keys (a tier, a kind) or a type, each with its reason. */
const ALLOWED: ReadonlySet<string> = new Set([
  ")[number]", // an element type, `(typeof X)[number]`
  "RouteOverrides[K]", // a field type
  "KIND_NOUNS[only]", // the five selector kinds
  "SCOPE_KEYS[kind]", // the three named scope kinds
  "models[outer]", // an array index
  "models[inner]", // an array index
  "KIND_NOUNS[kind]", // the five selector kinds, a closed set
  "SCOPE_KEYS[scope.kind]", // the three named scope kinds, a closed set
  "overrides[field]", // the same, by a field of that closed set
  "tables[kind]", // the four scope kinds, a closed set
  "lookups[kind]", // the five selector kinds
  "sets[kind]", // the four named selector kinds
]);

describe("a lookup by a chosen name reads only the record's own keys", () => {
  it("returns nothing for a name every object inherits", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(ownEntry({ a: 1 }, name)).toBeUndefined();
    }
    expect(ownEntry({ constructor: 2 }, "constructor")).toBe(2);
  });

  it.each(NAMED_LOOKUP_MODULES)("is the only spelling of a computed read in %s", (module) => {
    const text = fs.readFileSync(path.join(__dirname, module), "utf8").split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*\*)/.test(line)).join("\n");
    const raw = [...text.matchAll(RAW_COMPUTED_READ)].map((match) => match[0]).filter((read) => !ALLOWED.has(read.replace(/^\?\./, "")));
    expect(raw).toEqual([]);
  });

  it("allows nothing it does not need: each allowance is a read one of the modules makes", () => {
    const reads = new Set(NAMED_LOOKUP_MODULES.flatMap((module) => [...fs.readFileSync(path.join(__dirname, module), "utf8").matchAll(RAW_COMPUTED_READ)].map((match) => match[0].replace(/^\?\./, ""))));
    expect([...ALLOWED].filter((allowed) => !reads.has(allowed))).toEqual([]);
  });

  it("is a guard that can fail: a raw read by a chosen name is found", () => {
    expect([..."const v = models?.virtual?.[name];".matchAll(RAW_COMPUTED_READ)]).toHaveLength(1);
    expect([..."const p = readPools(paths)[name];".matchAll(RAW_COMPUTED_READ)]).toHaveLength(1);
    expect([..."const t = table[key];".matchAll(RAW_COMPUTED_READ)]).toHaveLength(1);
  });
});
