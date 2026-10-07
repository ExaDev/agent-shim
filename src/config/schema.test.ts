import { describe, expect, it } from "vitest";
import { z } from "zod";

import categoriesDefaultJson from "./categories.default.json";
import {
  CATEGORY_NAMES,
  CategoryClassificationSchema,
  CategoryMapSchema,
  ConfigProfileSchema,
  CredentialSchema,
  CredentialSourceSchema,
  DirectoryRuleSchema,
  DirectoryRulesSchema,
  DURATION_RE,
  ENTRY_KEY_RE,
  EntriesSchema,
  EntryValueSchema,
  GlobalConfigSchema,
  IdentitySchema,
  OVERRIDABLE_CATEGORIES,
  PortableConfigSchema,
  isCodexProvider,
  ProviderSchema,
  SHIPPED_CATEGORY_DEFAULTS,
  WhenConditionObjectSchema,
  WhenSchema,
} from "./schema";

/** Narrows `z.toJSONSchema`'s emitted output (typed as `unknown` by Zod) down to a plain object so tests can inspect its fields without a type assertion. */
function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("CategoryMapSchema", () => {
  it("accepts the four overridable categories", () => {
    expect(CategoryMapSchema.parse({ runtime: true, history: false, knowledge: true, settings: false })).toEqual({
      runtime: true,
      history: false,
      knowledge: true,
      settings: false,
    });
  });

  it("rejects `secret` at parse time rather than relying only on the resolver's runtime floor", () => {
    const result = CategoryMapSchema.safeParse({ secret: true });
    expect(result.success).toBe(false);
  });

  it("omits `secret` from its shape entirely, so the published JSON Schema cannot suggest it", () => {
    expect(Object.keys(CategoryMapSchema.in.shape).sort()).toEqual([...OVERRIDABLE_CATEGORIES, "all"].sort());
    expect(CATEGORY_NAMES).toContain("secret");
  });

  it("rejects an unknown category name", () => {
    expect(CategoryMapSchema.safeParse({ nonsense: true }).success).toBe(false);
  });

  it("expands `all: true` into every shareable category, leaving runtime closed, and `all: false` into every category", () => {
    expect(CategoryMapSchema.parse({ all: true })).toEqual({
      history: true,
      knowledge: true,
      settings: true,
    });
    expect(CategoryMapSchema.parse({ all: false })).toEqual({
      runtime: false,
      history: false,
      knowledge: false,
      settings: false,
    });
  });

  it("lets an explicit named category win over `all`, regardless of key order", () => {
    expect(CategoryMapSchema.parse({ all: true, history: false })).toEqual({
      history: false,
      knowledge: true,
      settings: true,
    });
    expect(CategoryMapSchema.parse({ history: false, all: true })).toEqual({
      history: false,
      knowledge: true,
      settings: true,
    });
  });

  it("opens runtime under `all: true` only when it is named explicitly", () => {
    expect(CategoryMapSchema.parse({ all: true, runtime: true })).toEqual({
      runtime: true,
      history: true,
      knowledge: true,
      settings: true,
    });
  });

  it("drops `all` from the result when it is absent, leaving only the named categories given", () => {
    expect(CategoryMapSchema.parse({ history: true })).toEqual({ history: true });
  });
});

describe("ENTRY_KEY_RE", () => {
  it.each([
    "knowledge/skills/commit",
    "history/projects/~/work/clients/*",
    "settings/settings.json",
    "runtime/cache",
    "secret/.credentials.json",
  ])("accepts the category-prefixed key %s", (key) => {
    expect(ENTRY_KEY_RE.test(key)).toBe(true);
  });

  it.each(["skills/commit", "knowledge", "knowledge/", "/knowledge/skills", "knowledge//skills", "unknown/thing"])(
    "rejects %s",
    (key) => {
      expect(ENTRY_KEY_RE.test(key)).toBe(false);
    },
  );

  it("rejects a bare, un-prefixed entries key at parse time", () => {
    expect(EntriesSchema.safeParse({ ".credentials.json": true }).success).toBe(false);
  });
});

describe("EntryValueSchema", () => {
  it("accepts a flat boolean", () => {
    expect(EntryValueSchema.parse(true)).toBe(true);
  });

  it("accepts a conditional value", () => {
    expect(EntryValueSchema.parse({ value: true, when: { newerThan: "90d" } })).toEqual({
      value: true,
      when: { newerThan: "90d" },
    });
  });

  it("rejects a conditional value with no `value`", () => {
    expect(EntryValueSchema.safeParse({ when: { newerThan: "90d" } }).success).toBe(false);
  });
});

describe("WhenSchema", () => {
  it.each(["90d", "1w", "500ms", "12h", "30m", "45s", "0d"])("accepts the duration %s", (duration) => {
    expect(DURATION_RE.test(duration)).toBe(true);
    expect(WhenConditionObjectSchema.parse({ newerThan: duration }).newerThan).toBe(duration);
  });

  it.each(["90", "d", "90 d", "90days", "-1d", "1.5d", ""])("rejects the malformed duration %s", (duration) => {
    expect(WhenSchema.safeParse({ newerThan: duration }).success).toBe(false);
  });

  it("takes zero or more environment-variable checks in one object, not a single fixed pair", () => {
    const when = WhenConditionObjectSchema.parse({ env: { CI: "1", DEPLOY_ENV: "staging" } });
    expect(when.env).toEqual({ CI: "1", DEPLOY_ENV: "staging" });
  });

  it("accepts an empty object, which is vacuously true", () => {
    expect(WhenSchema.parse({})).toEqual({});
  });

  it("accepts a predicate tree beside the object form, the union that needs no migration", () => {
    const tree = WhenSchema.parse({ kind: "anyOf", operands: [{ kind: "textCompare", op: "equals", left: { kind: "reference", key: "env.CI" }, right: { kind: "textLiteral", value: "1" } }, { kind: "not", operand: { kind: "exists", operand: { kind: "reference", key: "repo.branch" } } }] });
    expect(tree).toMatchObject({ kind: "anyOf" });
    // The object form still parses through the same union unchanged.
    expect(WhenSchema.parse({ newerThan: "1d" })).toEqual({ newerThan: "1d" });
    // A tree with a node the evaluator does not know is rejected by the schema itself, not discovered at evaluation time.
    expect(WhenSchema.safeParse({ kind: "nonsense" }).success).toBe(false);
  });

  it("rejects a non-positive maxSizeBytes", () => {
    expect(WhenSchema.safeParse({ maxSizeBytes: 0 }).success).toBe(false);
    expect(WhenSchema.safeParse({ maxSizeBytes: 1.5 }).success).toBe(false);
  });
});

describe("ConfigProfileSchema", () => {
  it("takes `extends` as a flat list of profile names", () => {
    const profile = ConfigProfileSchema.parse({ extends: ["base", "work"], categories: { history: false } });
    expect(profile.extends).toEqual(["base", "work"]);
  });

  it("rejects an unknown top-level key", () => {
    expect(ConfigProfileSchema.safeParse({ categorys: {} }).success).toBe(false);
  });

  it("accepts a launch.provider selection", () => {
    const profile = ConfigProfileSchema.parse({ launch: { provider: "z" } });
    expect(profile.launch?.provider).toBe("z");
  });

  it("rejects an empty launch.provider name", () => {
    expect(ConfigProfileSchema.safeParse({ launch: { provider: "" } }).success).toBe(false);
  });

  it("cannot express a circular extends definition as a schema concern — nothing in its shape points back at a profile", () => {
    // `a` extends `b` extends `a` validates fine file-by-file; the walker in src/resolve/extends.ts owns cycle detection.
    expect(ConfigProfileSchema.parse({ extends: ["b"] }).extends).toEqual(["b"]);
    expect(ConfigProfileSchema.parse({ extends: ["a"] }).extends).toEqual(["a"]);
  });
});

describe("DirectoryRuleSchema", () => {
  it("requires a path and accepts a profile selection, identity pin, and inline overrides", () => {
    const rule = DirectoryRuleSchema.parse({
      path: "~/work/clients/acme",
      configProfile: "client-acme",
      identity: "work",
      categories: { history: false },
      entries: { "knowledge/skills/commit": true },
      when: { branch: "client/*" },
    });
    expect(rule.path).toBe("~/work/clients/acme");
    expect(rule.identity).toBe("work");
  });

  it("rejects a rule with no path", () => {
    expect(DirectoryRuleSchema.safeParse({ configProfile: "x" }).success).toBe(false);
  });

  it("drops `description`, which only makes sense on a named profile", () => {
    expect(DirectoryRuleSchema.safeParse({ path: "/x", description: "hello" }).success).toBe(false);
  });
});

describe("DirectoryRulesSchema", () => {
  it("parses the README's own example rules file", () => {
    const rules = [
      { path: "~/work", configProfile: "work-default" },
      { path: "~/work/clients", configProfile: "client-strict", identity: "work" },
      { path: "~/work/clients/example", entries: { "knowledge/skills/example-notes": true } },
    ];
    const parsed = DirectoryRulesSchema.parse({ rules });
    expect(parsed.rules).toHaveLength(rules.length);
  });
});

describe("PortableConfigSchema", () => {
  it("has no `path` field, because a committed file's scope is implicit in where it lives", () => {
    expect(PortableConfigSchema.safeParse({ path: "/x" }).success).toBe(false);
    expect(PortableConfigSchema.parse({ categories: { history: false } }).categories).toEqual({ history: false });
  });
});

describe("GlobalConfigSchema", () => {
  it("carries the global default profile and walk-up limit", () => {
    const config = GlobalConfigSchema.parse({ defaultConfigProfile: "base", walkUpLimit: "~/" });
    expect(config.defaultConfigProfile).toBe("base");
    expect(config.walkUpLimit).toBe("~/");
  });

  it("carries the launch-time update mode, and an absent update block means no mode at all", () => {
    expect(GlobalConfigSchema.parse({}).update).toBeUndefined();
    expect(GlobalConfigSchema.parse({ update: {} }).update).toEqual({});
    for (const mode of ["off", "notify", "auto"] as const) {
      expect(GlobalConfigSchema.parse({ update: { mode } }).update).toEqual({ mode });
    }
    expect(GlobalConfigSchema.safeParse({ update: { mode: "sometimes" } }).success).toBe(false);
  });
});

describe("ProviderSchema", () => {
  const base = { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic" };
  const credential = { sources: [{ env: "Z_API_TOKEN" }] };

  it("accepts a full provider definition with static extra env", () => {
    const provider = ProviderSchema.parse({ ...base, credential, env: { ANTHROPIC_MODEL: "glm-4.6" } });
    expect(provider.env).toEqual({ ANTHROPIC_MODEL: "glm-4.6" });
    expect(provider.credential).toEqual(credential);
  });

  it("requires a credential block with at least one source", () => {
    expect(ProviderSchema.safeParse(base).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...base, credential: { sources: [] } }).success).toBe(false);
  });

  it("rejects the fields the credential block replaced", () => {
    expect(ProviderSchema.safeParse({ ...base, credential, tokenEnv: "Z_API_TOKEN" }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...base, credential, tokenCommand: ["op"] }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...base, credential, authScheme: "apiKey" }).success).toBe(false);
  });

  it("rejects any credential variable in env, even an empty one, since agent-shim sets and clears them itself", () => {
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(ProviderSchema.safeParse({ ...base, credential, env: { [key]: "" } }).success).toBe(false);
      expect(ProviderSchema.safeParse({ ...base, credential, env: { [key]: "value" } }).success).toBe(false);
    }
  });

  it("accepts target bearer or apiKey and rejects oauthToken, which only an identity may use", () => {
    expect(ProviderSchema.parse({ ...base, credential: { ...credential, target: "apiKey" } }).credential.target).toBe("apiKey");
    expect(ProviderSchema.parse({ ...base, credential: { ...credential, target: "bearer" } }).credential.target).toBe("bearer");
    expect(ProviderSchema.parse({ ...base, credential }).credential.target).toBeUndefined();
    expect(ProviderSchema.safeParse({ ...base, credential: { ...credential, target: "oauthToken" } }).success).toBe(false);
  });

  it("makes env optional but every other field required", () => {
    expect(ProviderSchema.safeParse({ ...base, credential }).success).toBe(true);
    expect(ProviderSchema.safeParse({ displayName: "GLM", credential }).success).toBe(false);
    expect(ProviderSchema.safeParse({ baseUrl: "https://api.z.ai", credential }).success).toBe(false);
  });

  it("rejects a baseUrl that is not a URL", () => {
    expect(ProviderSchema.safeParse({ ...base, baseUrl: "not-a-url", credential }).success).toBe(false);
  });

  it("rejects an unknown top-level key, so a token pasted in as a value cannot hide in one", () => {
    expect(ProviderSchema.safeParse({ ...base, credential, token: "sk-live" }).success).toBe(false);
  });

  it("accepts an explicit http kind with the same fields as an untagged provider", () => {
    expect(ProviderSchema.parse({ kind: "http", ...base, credential }).kind).toBe("http");
  });

  it("accepts a codex provider with no base URL and optional translation settings", () => {
    const codex = ProviderSchema.parse({ kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "x" }] }, codex: { models: { haiku: "gpt-small" }, effort: "none" } });
    expect(isCodexProvider(codex)).toBe(true);
    expect(ProviderSchema.safeParse({ kind: "codex", displayName: "Codex", credential }).success).toBe(true);
  });

  it("rejects a codex provider with a base URL, an unknown tier or effort, and codex settings on an http provider", () => {
    expect(ProviderSchema.safeParse({ kind: "codex", ...base, credential }).success).toBe(false);
    expect(ProviderSchema.safeParse({ kind: "codex", displayName: "Codex", credential, codex: { models: { gpt: "x" } } }).success).toBe(false);
    expect(ProviderSchema.safeParse({ kind: "codex", displayName: "Codex", credential, codex: { effort: "max" } }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...base, credential, codex: {} }).success).toBe(false);
    expect(ProviderSchema.safeParse({ kind: "other", ...base, credential }).success).toBe(false);
  });

  it("reports which field an invalid http provider is missing", () => {
    const result = ProviderSchema.safeParse(base);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toEqual(["credential"]);
  });
});

describe("CredentialSchema", () => {
  it("is the block identities use as is: any target, oauthToken included, and at least one source", () => {
    expect(CredentialSchema.parse({ sources: [{ env: "T" }], target: "oauthToken" }).target).toBe("oauthToken");
    expect(CredentialSchema.parse({ sources: [{ env: "T" }] }).target).toBeUndefined();
    expect(CredentialSchema.safeParse({ sources: [] }).success).toBe(false);
    expect(CredentialSchema.safeParse({ sources: [{ env: "T" }], target: "basic" }).success).toBe(false);
  });
});

describe("CredentialSourceSchema", () => {
  it("accepts every source kind", () => {
    for (const source of [
      { env: "Z_API_TOKEN" },
      { file: "~/.config/z.token" },
      { file: "/etc/agent-shim/z.token" },
      { command: ["pass", "show", "z"], interactive: true, timeoutMs: 5000 },
      { op: "op://vault/item/field" },
      { keychain: { service: "claude-work", account: "joe" }, interactive: false },
      { keychain: { service: "claude-work" } },
      { literal: "codex-local" },
    ]) {
      expect(CredentialSourceSchema.safeParse(source).success).toBe(true);
    }
  });

  it("rejects an object naming two kinds, an empty argv or program, an unprefixed op reference and a relative file", () => {
    for (const source of [
      { env: "A", file: "/b" },
      { command: [] },
      { command: [""] },
      { op: "vault/item/field" },
      { file: "relative/z.token" },
      { env: "" },
      { literal: "" },
      { env: "A", interactive: true },
      { command: ["x"], timeoutMs: 0 },
    ]) {
      expect(CredentialSourceSchema.safeParse(source).success).toBe(false);
    }
  });
});

describe("IdentitySchema", () => {
  it("accepts a credential block with any target, oauthToken included", () => {
    const identity = IdentitySchema.parse({ name: "work", credential: { sources: [{ op: "op://vault/claude-work/token" }], target: "oauthToken" } });
    expect(identity.credential?.target).toBe("oauthToken");
    expect(IdentitySchema.parse({ name: "work" }).credential).toBeUndefined();
    expect(IdentitySchema.safeParse({ name: "work", credential: { sources: [] } }).success).toBe(false);
  });

  it("defaults allowAmbientCredential to false, so a shared credential is always a deliberate choice", () => {
    expect(IdentitySchema.parse({ name: "work" }).allowAmbientCredential).toBe(false);
  });

  it.each(["work", "personal-2", "a.b_c", "X9"])("accepts the identity name %s", (name) => {
    expect(IdentitySchema.parse({ name }).name).toBe(name);
  });

  it.each(["-leading", ".hidden", "with space", "", "sla/sh"])("rejects the identity name %s", (name) => {
    expect(IdentitySchema.safeParse({ name }).success).toBe(false);
  });
});

describe("CategoryClassificationSchema", () => {
  it("is a different shape from CategoryMapSchema — lists of patterns per category, not booleans", () => {
    const parsed = CategoryClassificationSchema.parse(categoriesDefaultJson);
    expect(Array.isArray(parsed.secret)).toBe(true);
    expect(CategoryMapSchema.safeParse(parsed).success).toBe(false);
  });

  it("includes `secret`, unlike CategoryMapSchema — classification and toggling are separate concepts", () => {
    expect(Object.keys(CategoryClassificationSchema.shape)).toContain("secret");
  });

  it("classifies the shipped default map's own entries into the README's five categories", () => {
    const parsed = CategoryClassificationSchema.parse(categoriesDefaultJson);
    expect(parsed.secret).toContain(".credentials.json");
    expect(parsed.secret).toContain("backups");
    expect(parsed.knowledge).toContain("skills");
    expect(parsed.settings).toContain("settings.json");
    expect(parsed.history).toContain("projects");
    expect(parsed.runtime).toContain("shell-snapshots");
  });
});

describe("SHIPPED_CATEGORY_DEFAULTS", () => {
  it("shares knowledge, settings, and history out of the box, leaving only runtime and secret closed", () => {
    expect(SHIPPED_CATEGORY_DEFAULTS).toEqual({
      secret: false,
      runtime: false,
      history: true,
      knowledge: true,
      settings: true,
    });
  });
});

describe("JSON Schema generation", () => {
  it.each([
    ["CategoryMapSchema", CategoryMapSchema],
    ["WhenSchema", WhenSchema],
    ["EntriesSchema", EntriesSchema],
    ["ConfigProfileSchema", ConfigProfileSchema],
    ["DirectoryRulesSchema", DirectoryRulesSchema],
    ["GlobalConfigSchema", GlobalConfigSchema],
    ["IdentitySchema", IdentitySchema],
    ["CategoryClassificationSchema", CategoryClassificationSchema],
    ["PortableConfigSchema", PortableConfigSchema],
  ])("emits a JSON Schema for %s without any unrepresentable construct", (_name, schema) => {
    expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
  });

  it("emits real propertyNames validation for entries keys, which a bare path key could not express", () => {
    const jsonSchema = z.toJSONSchema(EntriesSchema, { io: "input" });
    if (!isJsonSchemaRecord(jsonSchema) || !isJsonSchemaRecord(jsonSchema.propertyNames)) {
      throw new Error("expected a propertyNames object in the emitted JSON Schema");
    }
    expect(jsonSchema.propertyNames.pattern).toBeTypeOf("string");
  });

  it("leaves a defaulted key optional in the input schema rather than marking it required", () => {
    const jsonSchema = z.toJSONSchema(IdentitySchema, { io: "input" });
    const required = isJsonSchemaRecord(jsonSchema) && Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
    expect(required).not.toContain("allowAmbientCredential");
  });
});
