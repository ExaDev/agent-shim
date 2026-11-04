import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import type { CodexProvider } from "../config/schema";
import type { LayoutPaths } from "../paths";

import { parseSiwcFile } from "./siwcStore";

const CatalogueBindingSchema = z.strictObject({ fingerprint: z.string().min(1), source: z.string().min(1), revision: z.string().min(1) });

/** Parses a non-secret catalogue binding, or returns undefined when absent or malformed. */
export function parseCatalogueBinding(raw: string | undefined): z.infer<typeof CatalogueBindingSchema> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = CatalogueBindingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A non-secret binding between a catalogue and the credentials used to fetch it. */
export function catalogueCredentialFingerprint(cli: boolean, token: string, accountId: string | undefined): string {
  return createHash("sha256").update(JSON.stringify([cli, token, accountId])).digest("hex");
}

/** The binding of a Codex CLI auth file, or undefined when it has no usable token. */
export function cliCatalogueFingerprint(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid Codex login file");
  }
  if (typeof value !== "object" || value === null || !("tokens" in value) || typeof value.tokens !== "object" || value.tokens === null || !("access_token" in value.tokens) || typeof value.tokens.access_token !== "string") return undefined;
  const accountId = "account_id" in value.tokens && typeof value.tokens.account_id === "string" ? value.tokens.account_id : undefined;
  return catalogueCredentialFingerprint(true, value.tokens.access_token, accountId);
}

/** The binding of a Sign in with ChatGPT grant, or undefined when no grant is stored. */
function signInCatalogueFingerprint(raw: string | undefined, filePath: string): string | undefined {
  if (raw === undefined) return undefined;
  const grant = parseSiwcFile(raw, filePath).grant;
  return grant === undefined ? undefined : catalogueCredentialFingerprint(false, grant.accessToken, undefined);
}

/** The binding of the login a Codex provider selects, read through the caller's filesystem port. */
export function savedCatalogueFingerprint(provider: CodexProvider, paths: Pick<LayoutPaths, "chatgptSignInFile">, env: Readonly<Record<string, string | undefined>>, home: string, read: (filePath: string) => string | undefined): string | undefined {
  if (provider.codex?.login === "chatgpt-sign-in") return signInCatalogueFingerprint(read(paths.chatgptSignInFile), paths.chatgptSignInFile);
  const configuredHome = env.CODEX_HOME;
  const codexHome = configuredHome === undefined || configuredHome === "" ? path.join(home, ".codex") : configuredHome;
  return cliCatalogueFingerprint(read(path.join(codexHome, "auth.json")));
}
