import fs from "node:fs";
import path from "node:path";
import { spawnSyncBlocking } from "./blockingSpawn";
import { findExecutableInDir, realFsPort } from "./realPorts";

/** Returns the real path when readable, and the input when it cannot be resolved. */
export function realpathOrSelf(target: string): string {
  try { return fs.realpathSync(target); } catch { return target; }
}

/** A literal forwarding script needs only a shebang, an exec line and a platform-length path. */
const MAX_FORWARDING_SCRIPT_BYTES = 8192;

/** Resolves an active mise shim through mise, or its first PATH fallback when mise reports that the tool is inactive. */
export function resolveMiseDispatcher(target: string, pathDirs: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  const executable = realpathOrSelf(target);
  if (path.basename(executable) !== "mise") return undefined;
  const result = spawnSyncBlocking("a mise shim lookup", executable, ["which", path.basename(target)], { encoding: "utf8", env });
  if (result.error !== undefined) return undefined;
  if (result.status === 0 && result.stdout.trim() !== "") return result.stdout.trim();
  if (!result.stderr.includes("not currently active")) return undefined;
  for (const dir of pathDirs) {
    const candidate = findExecutableInDir(dir, path.basename(target));
    if (candidate !== undefined && realpathOrSelf(candidate) !== executable) {
      try {
        const script = fs.statSync(candidate).size <= MAX_FORWARDING_SCRIPT_BYTES ? realFsPort.readFileUtf8(candidate) : undefined;
        const forwarded = script === undefined ? undefined : /^#!\/bin\/sh\r?\nexec (\/[A-Za-z0-9_./+-]+) "\$@"\r?\n?$/.exec(script)?.[1];
        return forwarded ?? candidate;
      } catch {
        return candidate;
      }
    }
  }
  return undefined;
}

