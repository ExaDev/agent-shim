import path from "node:path";
import { parseEnvBool } from "../cli/envBool";

const CODEX_AMBIENT_CREDENTIALS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_FEDERATION_RULE_ID"] as const;

export type CodexCredentialGuardResult = { readonly ok: true } | { readonly ok: false; readonly variable: string; readonly message: string };

/** The sharing source is explicit, never the CODEX_HOME inherited from another identity's session. */
export function canonicalCodexHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return path.resolve(env.AGENT_SHIM_CODEX_HOME === undefined || env.AGENT_SHIM_CODEX_HOME === "" ? path.join(home, ".codex") : env.AGENT_SHIM_CODEX_HOME);
}

/** Guard known environment authentication sources; diagnostics name variables, never their contents. */
export function codexCredentialGuard(env: Readonly<Record<string, string | undefined>>, allowAmbientCredential: boolean): CodexCredentialGuardResult {
  const variable = CODEX_AMBIENT_CREDENTIALS.find((key) => (env[key] ?? "") !== "");
  if (variable === undefined || allowAmbientCredential || parseEnvBool("AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL", env.AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL) === true) return { ok: true };
  return { ok: false, variable, message: `Ambient Codex credential variable ${variable} overrides the selected login. Unset it or explicitly allow ambient credentials with AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1 or identity set <name> --allow-ambient-credential.` };
}
