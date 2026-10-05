import { z } from "zod";

import { CATEGORY_NAMES, CREDENTIAL_CACHE_STORES, CREDENTIAL_TARGETS, CredentialCacheSchema } from "./config/schema";
import { CLAUDE_VERSION_SOURCES } from "./launcher/claudeVersion";
import { CONFIG_PROFILE_DECISION_SOURCES, IDENTITY_DECISION_SOURCES } from "./launcher/identity";
import { ENCODING_AMBIGUITY_REASONS } from "./resolve/projects";
import { DECISION_VIAS, DIAGNOSTIC_CODES, DIAGNOSTIC_SEVERITIES, LAYER_KINDS } from "./resolve/types";
import { PoolPickReportSchema } from "./usage/pickReportSchema";

/**
 * The Zod schema of `agent-shim check --json`'s output: one definition of the report's wire shape, so the JSON conversion (`checkReportToJson`, whose return type is this schema's inferred type, which makes the compiler prove the two agree) and every programmatic consumer of the report (the front door's `check.run` procedure above all) validate through the same source. A plain Zod leaf mirroring the shapes the report's own modules define; the vocabularies it switches on (layer kinds, decision routes, diagnostic codes and severities, decision sources) are imported as const arrays from those modules rather than restated here, so a vocabulary added there is a compile error here until this schema names it.
 */

/** Which credential a launch would use, as the report's own credential block states it. */
export const CHECK_CREDENTIAL_APPLIES = ["provider", "identity", "stored-login"] as const;

/** One cascade layer as the report lists it: identity and origin only, never the layer's rules. */
const CheckLayerViewSchema = z.strictObject({
  id: z.int(),
  kind: z.enum(LAYER_KINDS),
  source: z.string(),
});

/** One entry's resolved decision as the report states it: the verdict, the route that produced it, and the rule behind that route when one matched. */
const CheckEntryViewSchema = z.strictObject({
  path: z.string(),
  shared: z.boolean(),
  via: z.enum(DECISION_VIAS),
  /** The entry's real category, or null when nothing classifies it. */
  category: z.enum(CATEGORY_NAMES).nullable(),
  rule: z.strictObject({ key: z.string(), layer: z.int() }).optional(),
  /** Rules that matched but whose `when` condition failed, each with the conditions that failed. */
  eliminated: z.readonly(z.array(z.strictObject({ key: z.string(), failed: z.readonly(z.array(z.string())) }))).optional(),
});

/** One resolver diagnostic, verbatim as the resolver raises it. */
const CheckDiagnosticSchema = z.strictObject({
  code: z.enum(DIAGNOSTIC_CODES),
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  message: z.string(),
  subject: z.string().optional(),
  layer: z.int().optional(),
});

/** The ambient-credential guard's verdict: silent when it passes, the offending variable and the refusal message when it does not. */
const CheckAmbientCredentialSchema = z.union([z.strictObject({ ok: z.literal(true) }), z.strictObject({ ok: z.literal(false), variable: z.string(), message: z.string() })]);

/** The macOS Keychain lookup's result: whether an entry was found and the service name it names. */
const CheckKeychainSchema = z.strictObject({
  checked: z.literal(true),
  found: z.boolean(),
  serviceName: z.string().optional(),
  note: z.string(),
});

/** One file's settings exposure: names and counts only, never a value. */
const CheckSettingsExposureSchema = z.strictObject({
  file: z.string(),
  envKeyNames: z.readonly(z.array(z.string())),
  hookEventNames: z.readonly(z.array(z.string())),
  hookCommandCount: z.int().nonnegative(),
});

/** One credential source as the report summarises it: its kind and the non-secret detail that identifies it, never the token. */
const CredentialSourceSummarySchema = z.union([
  z.strictObject({ kind: z.literal("env"), variable: z.string() }),
  z.strictObject({ kind: z.literal("file"), path: z.string() }),
  z.strictObject({ kind: z.literal("command"), program: z.string() }),
  z.strictObject({ kind: z.literal("op"), reference: z.string() }),
  z.strictObject({ kind: z.literal("keychain"), service: z.string(), account: z.string().optional() }),
  z.strictObject({ kind: z.literal("literal") }),
]);

/** A credential block as the report summarises it: the target and each source's summary, plus the cache setting when the block asks for one. */
const CredentialSummarySchema = z.strictObject({
  target: z.enum(CREDENTIAL_TARGETS),
  sources: z.readonly(z.array(CredentialSourceSummarySchema)),
  cache: CredentialCacheSchema.optional(),
});

/** What a credential's cache holds, without the token: nothing, an unreadable store, or an entry with its age and expiry. */
const CachedCredentialStateSchema = z.union([
  z.strictObject({ store: z.enum(CREDENTIAL_CACHE_STORES), status: z.literal("empty") }),
  z.strictObject({ store: z.enum(CREDENTIAL_CACHE_STORES), status: z.literal("unreadable"), reason: z.string() }),
  z.strictObject({ store: z.enum(CREDENTIAL_CACHE_STORES), status: z.enum(["fresh", "expired"]), ageMs: z.number(), expiresInMs: z.number().optional() }),
]);

/** The selected provider as the report states it: its usable credential block, or why it could not be used. The two never appear together. */
const CheckCredentialProviderSchema = z.union([
  z.strictObject({ name: z.string(), credential: CredentialSummarySchema, cached: CachedCredentialStateSchema.optional() }),
  z.strictObject({ name: z.string(), problem: z.string() }),
]);

/** The credential report: which credential a launch would use, and each candidate block's summary. */
const CheckCredentialSchema = z.strictObject({
  applies: z.enum(CHECK_CREDENTIAL_APPLIES),
  provider: CheckCredentialProviderSchema.optional(),
  identity: CredentialSummarySchema.optional(),
  identityCached: CachedCredentialStateSchema.optional(),
});

/** The Claude Code version report: the pin and whether it is installed, or the highest installed version when nothing pins one. */
const CheckClaudeVersionSchema = z.strictObject({
  pinned: z.strictObject({ version: z.string(), source: z.enum(CLAUDE_VERSION_SOURCES), installed: z.boolean() }).optional(),
  highestInstalled: z.string().optional(),
  installed: z.readonly(z.array(z.string())),
});

/** Everything `agent-shim check` reports about one directory, as `check --json` prints it and the door's `check.run` procedure returns it. */
export const CheckReportJsonSchema = z.strictObject({
  identity: z.strictObject({ name: z.string().nullable(), source: z.enum(IDENTITY_DECISION_SOURCES) }),
  /** The pool ranking, when the launch named a pool instead of an identity. */
  pool: PoolPickReportSchema.optional(),
  configProfile: z.strictObject({ name: z.string().nullable(), source: z.enum(CONFIG_PROFILE_DECISION_SOURCES) }),
  layers: z.readonly(z.array(CheckLayerViewSchema)),
  entries: z.readonly(z.array(CheckEntryViewSchema)),
  projectEncodingAmbiguities: z.readonly(
    z.array(z.strictObject({ fragment: z.string(), encoded: z.string(), reason: z.enum(ENCODING_AMBIGUITY_REASONS), detail: z.string() })),
  ),
  diagnostics: z.readonly(z.array(CheckDiagnosticSchema)),
  ambientCredential: CheckAmbientCredentialSchema,
  keychain: CheckKeychainSchema.optional(),
  settingsExposure: z.readonly(z.array(CheckSettingsExposureSchema)),
  credential: CheckCredentialSchema,
  claudeVersion: CheckClaudeVersionSchema.optional(),
});
export type CheckReportJson = z.output<typeof CheckReportJsonSchema>;
