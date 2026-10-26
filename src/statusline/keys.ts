import { z } from "zod";

import { isPlainObject, ResolvedStatuslineSchema, STATUSLINE_COLOUR_NAMES, STATUSLINE_DEFAULTS, StatuslineSchema } from "../config/statusline";

/** How a setting's value is written: `boolean` is `true` or `false`, `choice` is one of a closed set, `list` an ordered list of such choices, `groups` a list of such lists, `textList` an ordered list of free text (a program and its arguments), and `colour` a colour name, a palette index from 0 to 255 or `#rrggbb`. */
type StatuslineKeyKind = "integer" | "boolean" | "text" | "choice" | "list" | "groups" | "textList" | "colour";

/** One statusline setting, as the schema declares it. */
export interface StatuslineKey {
  /** The dotted path of the setting inside `launch.statusline` (`bands.warnAt`). */
  readonly path: string;
  readonly kind: StatuslineKeyKind;
  /** The allowed values of a `choice`, or of each member of a `list`. */
  readonly choices: readonly string[];
  readonly description: string;
  /** The value the statusline uses when no layer sets the key; undefined for an optional key, which has none. */
  readonly defaultValue: unknown;
  /** Whether the key may stay unset with no default value, the statusline then behaving as its description says. */
  readonly optional: boolean;
  /** Whether a layer may write null for the key (`none` on the command line), which returns it, for the layers it is merged over, to its default, or to unset when it has none. */
  readonly unsettable: boolean;
}

function valueAt(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const part of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/** Whether a layer may write null at `path`, asked of the schema the configuration files are checked against. */
function acceptsNull(path: readonly string[]): boolean {
  const layer = path.reduceRight<unknown>((inner, part) => ({ [part]: inner }), null);
  return StatuslineSchema.safeParse(layer).success;
}

function keyOf(path: readonly string[], declared: z.ZodType): StatuslineKey {
  const optional = declared instanceof z.ZodOptional;
  const leaf = optional ? declared.unwrap() : declared;
  const common = { path: path.join("."), description: declared.description ?? "", defaultValue: valueAt(STATUSLINE_DEFAULTS, path), optional, unsettable: acceptsNull(path) };
  if (leaf instanceof z.ZodNumber) {
    return { ...common, kind: "integer", choices: [] };
  }
  if (leaf instanceof z.ZodBoolean) {
    return { ...common, kind: "boolean", choices: [] };
  }
  if (leaf instanceof z.ZodString) {
    return { ...common, kind: "text", choices: [] };
  }
  if (leaf instanceof z.ZodUnion) {
    return { ...common, kind: "colour", choices: [...STATUSLINE_COLOUR_NAMES] };
  }
  if (leaf instanceof z.ZodEnum) {
    return { ...common, kind: "choice", choices: Object.values(leaf.enum).map(String) };
  }
  if (leaf instanceof z.ZodArray && leaf.element instanceof z.ZodEnum) {
    return { ...common, kind: "list", choices: Object.values(leaf.element.enum).map(String) };
  }
  if (leaf instanceof z.ZodArray && leaf.element instanceof z.ZodArray && leaf.element.element instanceof z.ZodEnum) {
    return { ...common, kind: "groups", choices: Object.values(leaf.element.element.enum).map(String) };
  }
  if (leaf instanceof z.ZodArray && leaf.element instanceof z.ZodString) {
    return { ...common, kind: "textList", choices: [] };
  }
  throw new TypeError(`statusline setting ${path.join(".")} has a kind the key listing does not describe`);
}

function walk(shape: Readonly<Record<string, z.ZodType>>, prefix: readonly string[]): StatuslineKey[] {
  return Object.entries(shape).flatMap(([name, schema]) => (schema instanceof z.ZodObject ? walk(schema.shape, [...prefix, name]) : [keyOf([...prefix, name], schema)]));
}

/** Every statusline setting in declaration order, read from the schema itself, so the listing, the command line and the typed API can never disagree with what the configuration files accept. */
export function statuslineKeys(): readonly StatuslineKey[] {
  return walk(ResolvedStatuslineSchema.shape, []);
}

/** What the listing says of a setting's default: that it has none, and that `none` unsets it, or its value, and, where a layer may write null for it, that `none` returns it to that value. */
function defaultText(key: StatuslineKey): string {
  if (key.optional) {
    return "no default; none unsets it over shallower layers";
  }
  const value = `default ${JSON.stringify(key.defaultValue)}`;
  return key.unsettable ? `${value}; none returns it to the default over shallower layers` : value;
}

/** The listing `statusline keys` prints: each setting's path, then its kind with the choices it takes and its default (or that it has none, being optional), then what it does. */
export function formatStatuslineKeys(keys: readonly StatuslineKey[]): string {
  return keys
    .map((key) => {
      const takes = key.kind === "choice" || key.kind === "list" || key.kind === "groups" || key.kind === "colour" ? `${key.kind} of ${key.choices.join(", ")}` : key.kind;
      return `${key.path}  (${takes}; ${defaultText(key)})\n    ${key.description}`;
    })
    .join("\n");
}
