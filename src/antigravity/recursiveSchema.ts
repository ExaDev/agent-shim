import type { GeminiGenerateContentRequest } from "./geminiSchema";
import { ownEntry } from "../ownEntry";

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
 * On a required-reference-loop 400, relax the nearest required property on the
 * reported path in a private copy. If no required property remains, truncate only
 * the reported back-reference. The original tool still validates calls; descriptions
 * retain the constraints for the model. Other errors and schemas pass unchanged.
 */
export function relaxRejectedRecursiveProperty(request: GeminiGenerateContentRequest, body: string): GeminiGenerateContentRequest | undefined {
  const path = rejectedPath(body);
  if (path === undefined) return undefined;
  const propertyIndices = path.flatMap((part, index) => part === "properties" && path[index + 1] !== undefined ? [index] : []).reverse();
  if (propertyIndices.length === 0) return undefined;
  const copy = structuredClone(request);
  let changed = false;
  for (const tool of copy.tools ?? []) {
    for (const declaration of tool.functionDeclarations) {
      const schema = declaration.parametersJsonSchema;
      if (schema === undefined) continue;
      let leaf: unknown = schema;
      for (const part of path) leaf = descendExpanded(schema, leaf, part);
      if (!record(leaf) || typeof leaf.$ref !== "string") continue;
      let repairedProperty = false;
      for (const propertyIndex of propertyIndices) {
        const name = path[propertyIndex + 1];
        if (name === undefined) continue;
        let owner: unknown = schema;
        for (const part of path.slice(0, propertyIndex)) owner = descendExpanded(schema, owner, part);
        if (!record(owner) || !Array.isArray(owner.required) || !owner.required.includes(name) || !record(owner.properties)) continue;
        const property = ownEntry(owner.properties, name);
        if (!record(property)) continue;
        owner.required = owner.required.filter((item: unknown) => item !== name);
        const description = typeof property.description === "string" ? `${property.description}\n` : "";
        property.description = `${description}This property is required by the original tool schema.`;
        changed = true;
        repairedProperty = true;
        break;
      }
      if (!repairedProperty) {
        let parent: unknown = schema;
        for (const part of path.slice(0, -1)) parent = descendExpanded(schema, parent, part);
        const key = path.at(-1);
        const truncated = { description: "Recursive value: the original tool schema validates this value." };
        if (record(parent) && key !== undefined && Object.hasOwn(parent, key)) {
          parent[key] = truncated;
          changed = true;
        } else if (Array.isArray(parent) && key !== undefined && /^\d+$/u.test(key) && Number(key) < parent.length) {
          parent[Number(key)] = truncated;
          changed = true;
        }
      }
    }
  }
  return changed ? copy : undefined;
}
