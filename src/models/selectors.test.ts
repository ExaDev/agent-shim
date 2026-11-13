import { describe, expect, it } from "vitest";

import { expandSelectorName, parseSelectorName, SELECTOR_KINDS, type SelectorPorts, type SelectorTarget } from "./selectors";

/** A parse as the table writes it: undefined (not the grammar), a refusal's marker, or the parts. */
function parsed(name: string): unknown {
  const result = parseSelectorName(name);
  if (result === undefined) return undefined;
  return "refusal" in result ? "refused" : result.selector;
}

const NONE: SelectorTarget = { kind: "none" };

describe("the selector grammar", () => {
  it.each<[string, unknown]>([
    ["auto", undefined],
    ["auto[1m]", undefined],
    ["Auto/z", undefined],
    ["z/auto", undefined],
    ["claude-opus-5-5", undefined],
    ["auto/", "refused"],
    ["auto//sonnet", "refused"],
    ["auto/z/", "refused"],
    ["auto/pool:", "refused"],
    ["auto/pool:/sonnet", "refused"],
    ["auto/z", { name: "z", target: NONE }],
    ["auto/z/sonnet", { name: "z", target: { kind: "class", tier: "sonnet" } }],
    ["auto/z/Sonnet", { name: "z", target: { kind: "class", tier: "sonnet" } }],
    ["auto/z/fable", { name: "z", target: { kind: "class", tier: "fable" } }],
    ["auto/z/glm-5.3", { name: "z", target: { kind: "model", model: "glm-5.3" } }],
    ["auto/o/openai/gpt-5", { name: "o", target: { kind: "model", model: "openai/gpt-5" } }],
    ["auto/pool:subs/sonnet", { kind: "pool", name: "subs", target: { kind: "class", tier: "sonnet" } }],
    ["auto/provider:z", { kind: "provider", name: "z", target: NONE }],
    ["auto/family:glm-5-1", { kind: "family", name: "glm-5-1", target: NONE }],
    ["auto/foo:bar", { name: "foo:bar", target: NONE }],
    ["auto/z/sonnet[1m]", { name: "z", target: { kind: "class", tier: "sonnet" } }],
    ["auto/z[1M]", { name: "z", target: NONE }],
    ["auto/z/auto", { name: "z", target: { kind: "model", model: "auto" } }],
  ])("parses %j", (name, expected) => {
    expect(parsed(name)).toEqual(expected);
  });

  it("refuses with a message that names the name and the grammar", () => {
    const result = parseSelectorName("auto//sonnet");
    expect(result !== undefined && "refusal" in result ? result.refusal : "").toContain("auto/<selector>[/<class>]");
  });
});

/** A seeded generator (mulberry32), so a failing input is reproduced by its seed. */
function seededRandom(seed: number): () => number {
  const INCREMENT = 0x6d2b79f5;
  const SHIFT_A = 15;
  const SHIFT_B = 7;
  const SHIFT_C = 14;
  const MIX = 61;
  const RANGE = 4294967296;
  let state = seed;
  return () => {
    state = (state + INCREMENT) | 0;
    let t = Math.imul(state ^ (state >>> SHIFT_A), 1 | state);
    t = (t + Math.imul(t ^ (t >>> SHIFT_B), MIX | t)) ^ t;
    return ((t ^ (t >>> SHIFT_C)) >>> 0) / RANGE;
  };
}

/** The grammar written as one regular expression, the reference the hand-written parser is held to. */
function referenceParse(name: string): unknown {
  const bare = name.toLowerCase().endsWith("[1m]") ? name.slice(0, -"[1m]".length) : name;
  const match = /^auto\/([^/]*)(?:\/([\s\S]*))?$/.exec(bare);
  if (match === null) return undefined;
  const word = match[1] ?? "";
  const rest = match[2];
  const kinded = /^(profile|identity|pool|provider|family):([\s\S]*)$/.exec(word);
  const name_ = kinded === null ? word : (kinded[2] ?? "");
  if (name_ === "" || rest === "") return "refused";
  const tier = rest === undefined ? undefined : ["fable", "opus", "sonnet", "haiku"].find((candidate) => candidate === rest.toLowerCase());
  const target = rest === undefined ? NONE : tier === undefined ? { kind: "model", model: rest } : { kind: "class", tier };
  return { ...(kinded === null ? {} : { kind: kinded[1] }), name: name_, target };
}

describe("what the selector parser accepts, whatever it is given", () => {
  const SEED = 755;
  const INPUTS = 5000;
  const MAX_PARTS = 6;
  /** How often an input starts with the grammar's prefix, so most inputs exercise the parser beyond its first test. */
  const PREFIXED_SHARE = 0.7;
  const FRAGMENTS = ["auto", "auto/", "/", "//", "z", "pool:", "provider:", "family:", "identity:", "profile:", "foo:", ":", "sonnet", "Opus", "HAIKU", "fable", "[1m]", "[1M]", "glm-5.3", " ", "\u0000", "é", "auto[1m]"];

  function generate(random: () => number): string {
    const parts = Math.floor(random() * MAX_PARTS);
    let text = random() < PREFIXED_SHARE ? "auto/" : "";
    for (let index = 0; index < parts; index += 1) {
      text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? "";
    }
    return text;
  }

  it("parses every seeded input as the regular-expression reference does", () => {
    const random = seededRandom(SEED);
    for (let index = 0; index < INPUTS; index += 1) {
      const input = generate(random);
      expect(parsed(input), JSON.stringify(input)).toEqual(referenceParse(input));
    }
  });

  it("is a test that can fail: a parser that ignores the kind prefix differs from the reference", () => {
    const ignoringKinds = (name: string): unknown => {
      const reference = referenceParse(name);
      return typeof reference === "object" && reference !== null && "kind" in reference ? { ...reference, kind: undefined } : reference;
    };
    expect(ignoringKinds("auto/pool:subs")).not.toEqual(parsed("auto/pool:subs"));
  });
});

/** The live state the expansion reads, as fakes: a provider `z` mapping sonnet to `glm-4.7`, a router `r` with an opus pointer, a family `glm-5-1`, a profile on `z`, a profile on Anthropic, an identity on a provider, the session's own identity and its twin, another login, and a pool picking each of them. */
function ports(overrides: Partial<SelectorPorts> = {}): SelectorPorts {
  const found = <T>(value: T) => ({ kind: "found", value }) as const;
  const absent = { kind: "absent" } as const;
  return {
    profile: (name) => (name === "zprof" ? found({ provider: "z" }) : name === "plain" ? found({ provider: undefined }) : name === "both" ? found({ provider: undefined }) : name === "broken" ? { kind: "invalid", reason: 'configuration profile "broken" is invalid: bad' } : absent),
    identity: (name) => (name === "me" || name === "twin" || name === "work" ? found({ provider: undefined }) : name === "zid" ? found({ provider: "z" }) : absent),
    pool: (name) => (name === "subs" || name === "mine" || name === "spent" || name === "both" || name === "zpool" ? found(undefined) : absent),
    poolPick: (name) => (name === "subs" ? { identity: "work" } : name === "mine" ? { identity: "twin" } : name === "zpool" ? { identity: "zid" } : { refusal: `every member of pool "${name}" is refused right now; the earliest back is work at 2026-11-13T15:00:00.000Z` }),
    provider: (name) => (name === "z" || name === "r" || name === "both" ? found(undefined) : absent),
    providerTarget: (provider, target) => {
      if (provider === "r") return target.kind === "class" && target.tier === "opus" ? { name: "fast" } : target.kind === "model" ? { name: `r/${target.model}` } : { refusal: `provider "r" is a router` };
      if (provider !== "z") return { refusal: `no provider named "${provider}"` };
      return target.kind === "none" ? { name: "z/glm-4.7" } : target.kind === "class" ? { name: target.tier === "sonnet" ? "z/glm-4.7" : `z/${target.tier}` } : { name: `z/${target.model}` };
    },
    family: (key) => key === "glm-5-1" || key === "both",
    // The session runs on the identity whose directory id is "id-me"; its name is "me", and "twin" holds the same login.
    sameLogin: (identity, sessionIdentityId) => sessionIdentityId === "id-me" && (identity === "me" || identity === "twin"),
    // The session has sent a sonnet and an opus id on the Anthropic route, and no haiku or fable one.
    claudeNameOf: (tier) => (tier === "sonnet" ? "claude-sonnet-5-5" : tier === "opus" ? "claude-opus-5-5" : undefined),
    routeProvider: () => undefined,
    ...overrides,
  };
}

/** The session, by the identity id the launcher puts in its header, which differs from the identity's name. */
const ME = { identityId: "id-me" };

/** An expansion as the table writes it: the name, or the refusal's text. */
function expanded(name: string, session: Readonly<{ readonly identityId?: string }> = ME, given: SelectorPorts = ports()): string | undefined {
  const result = expandSelectorName(name, given, session);
  return result === undefined ? undefined : "refusal" in result ? `refused: ${result.refusal}` : result.name;
}

describe("expanding a selector against live state", () => {
  it.each<[string, string]>([
    ["auto/z", "z/glm-4.7"],
    ["auto/z/sonnet", "z/glm-4.7"],
    ["auto/z/opus", "z/opus"],
    ["auto/z/glm-5.3", "z/glm-5.3"],
    ["auto/provider:z/haiku", "z/haiku"],
    ["auto/r/opus", "fast"],
    ["auto/r/x-1", "r/x-1"],
    ["auto/glm-5-1", "family:glm-5-1"],
    ["auto/family:glm-5-1", "family:glm-5-1"],
    ["auto/zprof/sonnet", "z/glm-4.7"],
    ["auto/plain/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"],
    ["auto/zid/sonnet", "z/glm-4.7"],
    ["auto/me/claude-opus-5-5", "anthropic/claude-opus-5-5"],
    ["auto/twin/claude-opus-5-5", "anthropic/claude-opus-5-5"],
    ["auto/work/sonnet", "acct:work/sonnet"],
    ["auto/work/claude-opus-5-5", "acct:work/claude-opus-5-5"],
    ["auto/subs/sonnet", "acct:work/sonnet"],
    ["auto/pool:mine/claude-haiku-5-5", "anthropic/claude-haiku-5-5"],
    ["auto/zpool", "z/glm-4.7"],
    ["auto/z/sonnet[1m]", "z/glm-4.7"],
    ["auto/plain/sonnet", "anthropic/claude-sonnet-5-5"],
    ["auto/me/opus", "anthropic/claude-opus-5-5"],
    ["auto/pool:mine/sonnet", "anthropic/claude-sonnet-5-5"],
    ["auto/sonnet", "anthropic/claude-sonnet-5-5"],
    ["auto/Opus", "anthropic/claude-opus-5-5"],
  ])("expands %j to %j", (name, expected) => {
    expect(expanded(name)).toBe(expected);
  });

  it.each<[string, readonly string[]]>([
    ["auto/nothing", ["no configuration profile, identity, pool, provider or model family is called \"nothing\""]],
    ["auto/both/sonnet", ["\"both\" is ambiguous", "configuration profile", "pool", "provider", "model family", "auto/pool:both/sonnet", "auto/provider:both/sonnet", "auto/profile:both/sonnet", "auto/family:both/sonnet"]],
    ["auto/glm-5-1/sonnet", ["model family", "takes no class or model"]],
    ["auto/plain/haiku", ["Anthropic route", "no haiku request", "/model haiku"]],
    ["auto/plain", ["Anthropic route", "exact model"]],
    ["auto/me/fable", ["no fable request", "/model fable"]],
    ["auto/work", ["another login", "auto/work/<class>"]],
    ["auto/spent/sonnet", ["every member of pool \"spent\" is refused"]],
    ["auto/broken", ["is invalid: bad"]],
    ["auto/pool:nothing", ["no pool is called \"nothing\""]],
    ["auto/r", ["router"]],
  ])("refuses %j naming the cause and the next step", (name, fragments) => {
    const result = expanded(name);
    expect(result).toMatch(/^refused: /);
    for (const fragment of fragments) expect(result).toContain(fragment);
  });

  it("names every kind in the ambiguity refusal, so each spelling is offered", () => {
    const everything = ports({ profile: () => ({ kind: "found", value: { provider: undefined } }), identity: () => ({ kind: "found", value: { provider: undefined } }), pool: () => ({ kind: "found", value: undefined }), provider: () => ({ kind: "found", value: undefined }), family: () => true });
    const result = expanded("auto/x", ME, everything) ?? "";
    for (const kind of SELECTOR_KINDS) expect(result).toContain(`auto/${kind}:x`);
  });

  it("offers each kind's spelling with no trailing part when the selector names no class", () => {
    expect(expanded("auto/both")).toBe('refused: "both" is ambiguous: it names a configuration profile, a pool, a provider, a model family; say which with auto/profile:both, auto/pool:both, auto/provider:both, auto/family:both');
  });

  it.each<[string, string]>([["auto/sonnet", "z/glm-4.7"], ["auto/opus", "z/opus"]])("expands a class alone, %j, on the provider the session is on now, to %j", (name, expected) => {
    expect(expanded(name, ME, ports({ routeProvider: () => "z" }))).toBe(expected);
  });

  it("refuses a class alone that also names something, offering the class through /model", () => {
    const result = expanded("auto/sonnet", ME, ports({ profile: (name) => (name === "sonnet" ? { kind: "found", value: { provider: "z" } } : { kind: "absent" }) }));
    expect(result).toContain('"sonnet" is ambiguous');
    expect(result).toContain("auto/profile:sonnet");
    expect(result).toContain("/model sonnet");
  });

  it("treats a session with no identity as never on the selected login", () => {
    expect(expanded("auto/me/claude-opus-5-5", {})).toBe("acct:me/claude-opus-5-5");
  });

  it("leaves a name that is not the grammar alone", () => {
    expect(expanded("claude-opus-5-5")).toBeUndefined();
    expect(expanded("z/glm-5.3")).toBeUndefined();
    expect(expanded("auto")).toBeUndefined();
  });

  it("ranks a pool only when the selector is a pool", () => {
    let picks = 0;
    const counting = ports({ poolPick: (name) => { picks += 1; return ports().poolPick(name); } });
    expanded("auto/z/sonnet", ME, counting);
    expanded("auto/work/sonnet", ME, counting);
    expect(picks).toBe(0);
    expanded("auto/subs/sonnet", ME, counting);
    expect(picks).toBe(1);
  });
});
