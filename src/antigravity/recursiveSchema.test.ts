import { describe, expect, it } from "vitest";
import type { GeminiGenerateContentRequest } from "./geminiSchema";
import { relaxRejectedRecursiveProperty } from "./recursiveSchema";

const rejection = JSON.stringify({ error: { code: 400, message: "ref loops are only supported if they include optional or nullable property values, or a potentially-zero-length array items, but a ref loop of required fields was found at $defs.__schema0.properties.operand.oneOf.0", status: "INVALID_ARGUMENT" } });

function request(): GeminiGenerateContentRequest {
  return { contents: [], tools: [{ functionDeclarations: [{ name: "query", parametersJsonSchema: { $defs: { __schema0: { type: "object", properties: { operand: { description: "The expression", oneOf: [{ $ref: "#/$defs/__schema0" }, { type: "string" }] }, kind: { type: "string" } }, required: ["kind", "operand"] } }, type: "object", properties: { filter: { $ref: "#/$defs/__schema0" } }, required: ["filter"] } }] }] };
}

describe("rejected recursive schemas", () => {
  it("relaxes only the reported property and keeps its original requirement visible to the model", () => {
    const original = request();
    const before = structuredClone(original);
    const fixed = relaxRejectedRecursiveProperty(original, rejection);
    const schema = fixed?.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema;
    expect(schema).toMatchObject({ $defs: { __schema0: { properties: { operand: { description: "The expression\nThis property is required by the original tool schema." }, kind: { type: "string" } }, required: ["kind"] } }, required: ["filter"] });
    expect(original).toEqual(before);
    expect(fixed).not.toBe(original);
    if (fixed === undefined) throw new Error("expected a repaired request");
    const truncated = relaxRejectedRecursiveProperty(fixed, rejection);
    expect(truncated).toBeDefined();
    if (truncated === undefined) throw new Error("expected back-reference fallback");
    expect(relaxRejectedRecursiveProperty(truncated, rejection)).toBeUndefined();
  });

  it("follows the local reference Google expands in the reported path", () => {
    const original = request();
    const schema = original.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema as { $defs: Record<string, { properties?: Record<string, unknown>; oneOf?: unknown[] }> };
    schema.$defs.__schema1 = { oneOf: [{ $ref: "#/$defs/__schema0" }, { type: "string" }] };
    const properties = schema.$defs.__schema0?.properties;
    if (properties === undefined) throw new Error("missing properties");
    properties.operand = { $ref: "#/$defs/__schema1" };
    const fixed = relaxRejectedRecursiveProperty(original, rejection);
    expect(fixed?.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema).toMatchObject({ $defs: { __schema0: { required: ["kind"], properties: { operand: { $ref: "#/$defs/__schema1" } } } } });
  });

  it("tries the nearest remaining required ancestor when a path recurs", () => {
    const requestWithNestedLoop: GeminiGenerateContentRequest = { contents: [], tools: [{ functionDeclarations: [{ name: "query", parametersJsonSchema: {
      $defs: { __schema0: { type: "object", required: ["operand"], properties: { operand: { type: "object", required: ["key"], properties: { key: { $ref: "#/$defs/__schema0" } } } } } },
    } }] }] };
    const body = JSON.stringify({ error: { message: "ref loop of required fields was found at $defs.__schema0.properties.operand.properties.key" } });
    const first = relaxRejectedRecursiveProperty(requestWithNestedLoop, body);
    expect(first?.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema).toMatchObject({ $defs: { __schema0: { required: ["operand"], properties: { operand: { required: [] } } } } });
    if (first === undefined) throw new Error("expected first repair");
    const second = relaxRejectedRecursiveProperty(first, body);
    expect(second?.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema).toMatchObject({ $defs: { __schema0: { required: [] } } });
  });

  it("truncates a rejected back-reference only after its required ancestors are already relaxed", () => {
    const original = request();
    const schema = original.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema as { $defs: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
    const definition = schema.$defs.__schema0;
    if (definition?.properties === undefined) throw new Error("missing definition");
    definition.required = ["kind"];
    const fixed = relaxRejectedRecursiveProperty(original, rejection);
    expect(fixed?.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema).toMatchObject({ $defs: { __schema0: { properties: { operand: { oneOf: [{ description: "Recursive value: the original tool schema validates this value." }, { type: "string" }] } } } } });
    expect(definition.properties.operand).toMatchObject({ oneOf: [{ $ref: "#/$defs/__schema0" }, { type: "string" }] });
  });

  it("ignores a cyclic or external reference in the expanded path", () => {
    const original = request();
    const schema = original.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema as { $defs: Record<string, { properties?: Record<string, unknown> }> };
    const properties = schema.$defs.__schema0?.properties;
    if (properties === undefined) throw new Error("missing properties");
    properties.operand = { $ref: "#/$defs/__schema0/properties/operand" };
    expect(relaxRejectedRecursiveProperty(original, rejection)).toBeUndefined();
    properties.operand = { $ref: "https://example.test/schema" };
    expect(relaxRejectedRecursiveProperty(original, rejection)).toBeUndefined();
  });

  it("does not alter unrelated errors, non-reference paths, or absent requirements", () => {
    expect(relaxRejectedRecursiveProperty(request(), "not json")).toBeUndefined();
    expect(relaxRejectedRecursiveProperty(request(), JSON.stringify({ error: { message: "other error" } }))).toBeUndefined();
    expect(relaxRejectedRecursiveProperty(request(), rejection.replace("oneOf.0", "oneOf.1"))).toBeUndefined();
    expect(relaxRejectedRecursiveProperty(request(), rejection.replace("operand", "missing"))).toBeUndefined();
  });
});
