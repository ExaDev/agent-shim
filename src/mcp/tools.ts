import { z } from "zod";

import { READ_ONLY_OPERATION_EXTENSION } from "../frontdoor/rcApi";

/**
 * The subset of an OpenAPI operation the MCP adapter reads. The door's own generator produces the document, so this is validated rather than trusted: a document that stops matching surfaces as a refusal naming the field, not as a silently empty tool list.
 */
const JsonSchemaObjectSchema = z.record(z.string(), z.unknown());

const OperationSchema = z.object({
  operationId: z.string().min(1),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  [READ_ONLY_OPERATION_EXTENSION]: z.boolean().optional(),
  parameters: z
    .array(z.object({ in: z.string(), name: z.string(), required: z.boolean().optional(), schema: z.unknown().optional(), description: z.string().optional() }))
    .optional(),
  requestBody: z.object({ content: z.record(z.string(), z.object({ schema: JsonSchemaObjectSchema.optional() })) }).optional(),
  responses: z.record(z.string(), z.object({ content: z.record(z.string(), z.unknown()).optional() })).optional(),
});

const OpenApiDocumentSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/** One MCP tool derived from one operation of the door's OpenAPI document. */
export interface McpToolSpec {
  /** The tool name: the operation id with its dots replaced, since tool names admit only letters, digits, underscores and hyphens. */
  readonly name: string;
  readonly description: string;
  /** A JSON Schema object describing the arguments, taken from the operation's request body or its query parameters. */
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown };
  /** The procedure path a typed client or link calls: the operation id split on its dots. */
  readonly procedure: readonly string[];
  /** Whether the operation only reads: the HTTP method is GET, or the operation carries the read-only extension a POST read declares. */
  readonly readOnly: boolean;
  /** The operation's first OpenAPI tag, which names the domain it belongs to. */
  readonly tag: string | undefined;
}

/** The OpenAPI tag of the Remote Control procedures, whose writes act on other sessions and so need their own opt-in. */
export const REMOTE_CONTROL_TAG = "remote-control";

/** Which of the door's write operations a launch exposes as tools: none by default. */
export interface McpWritePermissions {
  /** Expose the writes that change the door's own configuration and lifecycle. */
  readonly writes: boolean;
  /** Expose the Remote Control writes, which send into and answer for other sessions. */
  readonly remoteControl: boolean;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function inputSchemaOf(operation: z.infer<typeof OperationSchema>): McpToolSpec["inputSchema"] {
  const body = operation.requestBody?.content["application/json"]?.schema;
  if (body !== undefined) {
    return { ...body, type: "object" };
  }
  const query = (operation.parameters ?? []).filter((parameter) => parameter.in === "query");
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of query) {
    properties[parameter.name] = parameter.description === undefined ? parameter.schema : { ...(typeof parameter.schema === "object" && parameter.schema !== null ? parameter.schema : {}), description: parameter.description };
    if (parameter.required === true) {
      required.push(parameter.name);
    }
  }
  return { type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
}

function isStream(operation: z.infer<typeof OperationSchema>): boolean {
  return Object.values(operation.responses ?? {}).some((response) => response.content !== undefined && "text/event-stream" in response.content);
}

function permitted(tag: string | undefined, readOnly: boolean, permissions: McpWritePermissions): boolean {
  if (readOnly) {
    return true;
  }
  return tag === REMOTE_CONTROL_TAG ? permissions.remoteControl : permissions.writes;
}

/**
 * Derives the MCP tool list from the door's OpenAPI document: one tool per non-streaming operation, named after its operation id, described by its summary and typed by its Zod-derived request schema, so the tool surface follows the router with no list kept here. Writes appear only where `permissions` allows their group.
 *
 * Throws when the document does not have the OpenAPI shape, when an operation lacks an operation id, or when two operations map to one tool name.
 */
export function toolsFromOpenApiDocument(document: unknown, permissions: McpWritePermissions): readonly McpToolSpec[] {
  const parsed = OpenApiDocumentSchema.parse(document);
  const tools: McpToolSpec[] = [];
  const seen = new Set<string>();
  for (const [route, byMethod] of Object.entries(parsed.paths)) {
    for (const method of HTTP_METHODS) {
      const raw = byMethod[method];
      if (raw === undefined) {
        continue;
      }
      const operation = OperationSchema.parse(raw);
      if (isStream(operation)) {
        continue;
      }
      const readOnly = method === "get" || operation[READ_ONLY_OPERATION_EXTENSION] === true;
      const tag = operation.tags?.[0];
      if (!permitted(tag, readOnly, permissions)) {
        continue;
      }
      const name = operation.operationId.replaceAll(".", "_");
      if (seen.has(name)) {
        throw new Error(`two operations of the door's OpenAPI document map to the MCP tool name ${name} (${route})`);
      }
      seen.add(name);
      tools.push({
        name,
        description: [operation.summary, operation.description].filter((part): part is string => part !== undefined).join(". "),
        inputSchema: inputSchemaOf(operation),
        procedure: operation.operationId.split("."),
        readOnly,
        tag,
      });
    }
  }
  return tools;
}
