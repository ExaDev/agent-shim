import { UsageError } from "../cliError";
import { resolveStatusline, StatuslineSchema, type StatuslineSettings } from "../config/statusline";

/** `settings` unchanged once its combination is known to be drawable. `source` names where they came from (`launch.statusline`, `AGENT_SHIM_STATUSLINE`) so a refusal says which to fix. */
export function checkedStatusline(settings: Readonly<StatuslineSettings>, source: string): StatuslineSettings {
  try {
    resolveStatusline(settings);
  } catch (error) {
    throw new UsageError(`${source}: ${error instanceof Error ? error.message : String(error)}.`);
  }
  return settings;
}

/** The settings a launch exported in `AGENT_SHIM_STATUSLINE`: a JSON object of `StatuslineSchema`, checked as a whole. Anything else fails loudly, naming the problem, since a statusline that silently ignored its settings would look like a renderer bug. */
export function statuslineSettingsFromEnv(raw: string, source: string): StatuslineSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${source}: not valid JSON.`);
  }
  const result = StatuslineSchema.safeParse(parsed);
  if (!result.success) {
    throw new UsageError(`${source}: ${result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}.`);
  }
  return checkedStatusline(result.data, source);
}
