import { UsageError } from "../cliError";
import { isPlainObject, StatuslineSchema, type StatuslineSettings } from "../config/statusline";
import { statuslineKeys, type StatuslineKey } from "./keys";

/** A change to a layer's statusline settings: dotted setting paths to the values to set, and dotted paths to remove so the shallower layers or the default apply again. */
export interface StatuslineChange {
  readonly set?: Readonly<Record<string, unknown>>;
  readonly unset?: readonly string[];
}

function keyNamed(path: string): StatuslineKey {
  const found = statuslineKeys().find((key) => key.path === path);
  if (found === undefined) {
    throw new UsageError(`"${path}" is not a statusline setting; \`agent-shim statusline keys\` lists them.`);
  }
  return found;
}

/** The value a `<setting>=<value>` option names, written the way the setting's kind is written: a whole number, text, one choice, or a comma-separated list of choices (an empty value is the empty list). The value's own validity is the schema's to judge. */
export function parseStatuslineAssignment(text: string): { readonly path: string; readonly value: unknown } {
  const split = text.indexOf("=");
  if (split < 1) {
    throw new UsageError(`"${text}" is not <setting>=<value>.`);
  }
  const path = text.slice(0, split);
  const raw = text.slice(split + 1);
  const key = keyNamed(path);
  switch (key.kind) {
    case "integer": {
      const number = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(number)) {
        throw new UsageError(`${path}: "${raw}" is not a number.`);
      }
      return { path, value: number };
    }
    case "text":
    case "choice":
      return { path, value: raw };
    case "list":
      return { path, value: raw === "" ? [] : raw.split(",") };
    default:
      return key.kind satisfies never;
  }
}

function setAt(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const [head, ...rest] = path;
  if (head === undefined) {
    return;
  }
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const child = target[head];
  const next = isPlainObject(child) ? child : {};
  target[head] = next;
  setAt(next, rest, value);
}

function removeAt(target: Record<string, unknown>, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) {
    return;
  }
  const child = target[head];
  if (rest.length === 0) {
    Reflect.deleteProperty(target, head);
    return;
  }
  if (isPlainObject(child)) {
    removeAt(child, rest);
    if (Object.keys(child).length === 0) {
      Reflect.deleteProperty(target, head);
    }
  }
}

/** `existing` with `change` applied, checked against the settings schema as a whole, or undefined once no setting is left. A path that names no setting, or a value the schema refuses, fails with the setting named. */
export function applyStatuslineChange(existing: Readonly<StatuslineSettings> | undefined, change: StatuslineChange): StatuslineSettings | undefined {
  const draft: Record<string, unknown> = structuredClone(existing ?? {});
  for (const [path, value] of Object.entries(change.set ?? {})) {
    keyNamed(path);
    setAt(draft, path.split("."), value);
  }
  for (const path of change.unset ?? []) {
    keyNamed(path);
    removeAt(draft, path.split("."));
  }
  const result = StatuslineSchema.safeParse(draft);
  if (!result.success) {
    throw new UsageError(`statusline: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}.`);
  }
  return Object.keys(result.data).length === 0 ? undefined : result.data;
}
