import type { FarmFs } from "./launcher/ports";

/** The guard every parsed file narrowing goes through, per the codebase's `unknown` discipline. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads and parses one JSON object file, or undefined when it is absent or not one JSON object. */
export function readJsonObject(fs: Pick<FarmFs, "readFileUtf8">, file: string): Record<string, unknown> | undefined {
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}
