import type { GeminiGenerateContentRequest } from "./geminiSchema";

/** Google identifies the recursive reference by a dot-delimited path inside one tool schema. */
function rejectedPath(body: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (!record(value) || !record(value.error) || typeof value.error.message !== "string") return undefined;
    const match = /ref loop of required fields was found at (\$defs\.[A-Za-z0-9_.$-]+)\s*$/u.exec(value.error.message);
    return match?.[1]?.split(".");
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descend(value: unknown, key: string): unknown {
  if (Array.isArray(value) && /^\d+$/u.test(key)) return value[Number(key)];
  return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

/**
 * Google reports paths through dereferenced local schemas; resolve refs only when
 * needed to traverse a segment, and reject external or cyclic references.
 */
function descendExpanded(root: unknown, value: unknown, key: string): unknown {
  const seen = new Set<string>();
  let current = value;
  for (;;) {
    const child = descend(current, key);
    if (child !== undefined) return child;
    if (!record(current) || typeof current.$ref !== "string" || !current.$ref.startsWith("#/") || seen.has(current.$ref)) return undefined;
    const ref = current.$ref;
    seen.add(ref);
    current = root;
    for (const part of ref.slice(2).split("/")) current = descend(current, part.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
}

/**
 * On the specific 400 reporting a required reference loop, relax only the named recursive
 * property in a private copy. The original tool still validates calls, and its description
 * tells the model the property remains required. Other errors and schemas pass unchanged.
 */
export function relaxRejectedRecursiveProperty(request: GeminiGenerateContentRequest, body: string): GeminiGenerateContentRequest | undefined {
  const path = rejectedPath(body);
  if (path === undefined) return undefined;
  const propertyIndex = path.lastIndexOf("properties");
  const name = path[propertyIndex + 1];
  if (propertyIndex < 0 || name === undefined) return undefined;
  const copy = structuredClone(request);
  let changed = false;
  for (const tool of copy.tools ?? []) {
    for (const declaration of tool.functionDeclarations) {
      const schema = declaration.parametersJsonSchema;
      if (schema === undefined) continue;
      let leaf: unknown = schema;
      for (const part of path) leaf = descendExpanded(schema, leaf, part);
      if (!record(leaf) || typeof leaf.$ref !== "string") continue;
      let owner: unknown = schema;
      for (const part of path.slice(0, propertyIndex)) owner = descendExpanded(schema, owner, part);
      if (!record(owner) || !Array.isArray(owner.required) || !owner.required.includes(name) || !record(owner.properties)) continue;
      const property = owner.properties[name];
      if (!record(property)) continue;
      owner.required = owner.required.filter((item: unknown) => item !== name);
      const description = typeof property.description === "string" ? `${property.description}\n` : "";
      property.description = `${description}This property is required by the original tool schema.`;
      changed = true;
    }
  }
  return changed ? copy : undefined;
}
