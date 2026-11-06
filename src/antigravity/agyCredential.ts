import type { AsyncCredentialPort, CredentialResolution } from "../credential";

const PREFIX = "go-keyring-base64:";
const COMMAND_TIMEOUT_MS = 30_000;

/** Extract only the fields needed for expiry checking; never include the envelope in errors. */
function envelope(raw: string): { token: string; expiry: number } | undefined {
  if (!raw.startsWith(PREFIX)) return undefined;
  try {
    const data: unknown = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8"));
    if (typeof data !== "object" || data === null || !("token" in data)) return undefined;
    const token = data.token;
    if (typeof token !== "object" || token === null || !("access_token" in token) || !("expiry" in token)) return undefined;
    if (typeof token.access_token !== "string" || token.access_token === "" || typeof token.expiry !== "string") return undefined;
    const expiry = Date.parse(token.expiry);
    return Number.isFinite(expiry) ? { token: token.access_token, expiry } : undefined;
  } catch {
    return undefined;
  }
}

/** Share refreshes for the same keychain item across inference and quota requests. */
export function createAgyCredentialResolver(port: AsyncCredentialPort, now: () => number = Date.now): (result: CredentialResolution) => Promise<CredentialResolution> {
  let inFlight: Promise<CredentialResolution> | undefined;
  async function resolve(result: CredentialResolution): Promise<CredentialResolution> {
    if (!result.ok) return result;
    const source = result.credential.source;
    if (!("keychain" in source) || source.keychain.service !== "gemini" || source.keychain.account !== "antigravity") return result;
    const read = async (): Promise<string | undefined> => {
      const item = await port.runCommand(["security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], { timeoutMs: 10_000, interactive: false });
      return item.status === 0 && !item.timedOut ? item.stdout.trim() : undefined;
    };
    const raw = await read();
    if (raw === undefined) return { ok: false, message: "Unable to read the agy credential envelope." };
    if (!raw.startsWith(PREFIX)) return result;
    let item = envelope(raw);
    if (item === undefined) return { ok: false, message: "Unable to read the agy credential envelope." };
    if (item.expiry <= now()) {
      const refreshed = await port.runCommand(["agy", "models"], { timeoutMs: COMMAND_TIMEOUT_MS, interactive: false });
      if (refreshed.status !== 0 || refreshed.timedOut) return { ok: false, message: "agy could not refresh its credential; check agy authentication." };
      const refreshedRaw = await read();
      item = refreshedRaw === undefined ? undefined : envelope(refreshedRaw);
      if (item === undefined || item.expiry <= now()) return { ok: false, message: "agy did not provide a fresh credential." };
    }
    return { ok: true, credential: { ...result.credential, token: item.token } };
  }
  return async (result) => {
    if (!result.ok || !("keychain" in result.credential.source) || result.credential.source.keychain.service !== "gemini" || result.credential.source.keychain.account !== "antigravity") return result;
    if (inFlight !== undefined) return await inFlight;
    const pending = resolve(result);
    inFlight = pending;
    try { return await pending; } finally { if (inFlight === pending) inFlight = undefined; }
  };
}
