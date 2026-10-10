import path from "node:path";

import { z } from "zod";

import { CredentialSummarySchema } from "../checkReportSchema";
import { CLAUDE_VERSION_SOURCES } from "../launcher/claudeVersion";
import { CONFIG_PROFILE_DECISION_SOURCES, IDENTITY_DECISION_SOURCES } from "../launcher/identity";

/**
 * The Zod schemas of the door's launch resolution: what a launch from one directory would resolve to, as data. The output is a closed shape of names, flags, paths and credential summaries (a target and each source's kind and non-secret identifier), so a token has nowhere to appear in it: a value outside the shape fails the door's own output validation instead of reaching the caller.
 */

/** The launch to resolve: the directory it is for (absolute, since the door has no working directory of the caller's to resolve a relative path against), the arguments after `agent-shim run` exactly as the command line takes them, and the environment the launch would inherit. */
export const LaunchResolveInputSchema = z
  .strictObject({
    path: z.string().min(1),
    /** `@name`, launch flags, then the arguments for `claude`; empty for a bare launch. */
    argv: z.readonly(z.array(z.string())).optional(),
    /** The launch's inherited environment. Absent means an empty one: the door's own environment is never a substitute for the caller's, so a caller that wants `AGENT_SHIM_*` switches or a `CLAUDE_CONFIG_DIR` considered names them here. Values are read, never reported. */
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine((input) => path.isAbsolute(input.path), { message: "path must be absolute: the door cannot resolve a relative path against the caller's working directory" });

/** The pool pick behind a launch's identity, as the launcher's decision reports it. */
const LaunchPoolDecisionSchema = z.strictObject({
  name: z.string(),
  reasons: z.readonly(z.array(z.string())),
  movedOff: z.strictObject({ identity: z.string(), reason: z.string() }).optional(),
});

/** What the launch resolved to and where each decision came from: names, sources and paths, never a credential. */
const LaunchDecisionSchema = z.strictObject({
  identity: z.string().optional(),
  identitySource: z.enum(IDENTITY_DECISION_SOURCES),
  pool: LaunchPoolDecisionSchema.optional(),
  configDirEscapeHatch: z.boolean(),
  configDir: z.string().optional(),
  configProfile: z.string().optional(),
  configProfileSource: z.enum(CONFIG_PROFILE_DECISION_SOURCES),
  provider: z.string().optional(),
});

/** The resolved launch flags: each after the command line, the environment and the cascade have had their say. */
const LaunchFlagsSchema = z.strictObject({
  skipPermissions: z.boolean(),
  remoteControl: z.boolean(),
  headroom: z.boolean(),
  trackUsage: z.boolean(),
});

/** One launch resolved, with the warnings the resolution raised. Nothing was started, written or recorded to produce it. */
export const LaunchResolveOutputSchema = z.strictObject({
  decision: LaunchDecisionSchema,
  flags: LaunchFlagsSchema,
  claudeVersion: z.strictObject({ version: z.string(), source: z.enum(CLAUDE_VERSION_SOURCES) }).optional(),
  /** The real `claude` binary the launch would spawn, on the door's host. */
  bin: z.string(),
  /** The arguments the launch would pass it: the tool's own flags, then `CLAUDE_EXTRA_FLAGS`, then the caller's own. */
  args: z.readonly(z.array(z.string())),
  /** The credential the launch would authenticate with, by target and source kinds. Absent when none applies. */
  credential: z.strictObject({ subject: z.enum(["provider", "identity"]), name: z.string(), summary: CredentialSummarySchema }).optional(),
  routing: z.strictObject({ frontDoor: z.boolean(), headroom: z.boolean() }),
  /** The names of the environment variables the launch would set or unset, sorted. Values are not reported. */
  environment: z.readonly(z.array(z.string())),
  warnings: z.readonly(z.array(z.string())),
});
