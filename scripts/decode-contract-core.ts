import { decodeContent, redactJson, type HttpExchange, type HttpMessage } from "./decode-http-capture-core";
import { decodeFrames, negotiationOf, type WebSocketDirection } from "./decode-websocket-core";

/**
 * The summarising half of `scripts/decode-http-capture.mts --contract`: folds every exchange of a capture into one entry per endpoint (host, method, path with its identifiers replaced), merging the request and response bodies of all the samples into a single shape, so what a service accepts and answers can be read as a contract rather than as a list of calls.
 *
 * A shape is a JSON value whose leaves name types: `string`, `number`, `boolean`, `null`, joined with `|` where samples disagree. A key missing from some samples carries a `?` suffix. A string is shown as its value only when it is one of a small closed set seen across several samples (a discriminator such as a `type` field), never from a single sample, so identifiers and prose never appear in a shape.
 */

/** A string field is reported as an enumeration only when at least this many samples held a string there. */
const ENUM_MIN_SAMPLES = 3;

/** ...and only when no more than this many distinct values were seen; past it the field is free text or an identifier. */
const ENUM_MAX_DISTINCT = 8;

/** Header names left out of an endpoint's request header list: transport and credential noise that says nothing about the contract. */
const NOISE_HEADERS: ReadonlySet<string> = new Set(["host", "connection", "accept-encoding", "accept", "user-agent", "content-length", "authorization", "proxy-authorization", "cookie", "x-api-key", "transfer-encoding", "accept-language", "sec-fetch-mode"]);

/** Headers whose values are part of the contract, kept with their values. */
const VALUED_HEADERS: ReadonlySet<string> = new Set(["anthropic-beta", "anthropic-version", "anthropic-client-platform", "content-type"]);

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An identifier always holds a digit, which is what tells `session_01X1jsRxbPvFw1yyDtFnVw39` and a long random token from a long route word such as `environment_providers`. */
const PREFIXED_ID_SEGMENT = /^([A-Za-z]+)_(?=[0-9A-Za-z]*\d)[0-9A-Za-z]{16,}$/;
const LONG_TOKEN_SEGMENT = /^(?=[0-9A-Za-z_-]*\d)[0-9A-Za-z_-]{20,}$/;

/** An object with more keys than this, in any one sample, is a map keyed by names (feature flags, settings by id) rather than a fixed record, and is shown as one entry whose key is `<key>`. A fixed record in these services stays well under it. */
const MAP_MIN_KEYS = 24;

/** The two segments after `code/repos` name an owner and a repository, which are data, not route. */
const REPO_ROUTE = /\/code\/repos\/[^/]+\/[^/]+/;

/** A path segment followed by one of these is the name of a collection member (`skills/{name}/download`), not a fixed part of the route. */
const MEMBER_ACTIONS: ReadonlySet<string> = new Set(["download"]);

/** The path of a request target with each identifier replaced by a placeholder naming its kind, and the query parameter names it carried. */
export function normaliseTarget(target: string): { readonly path: string; readonly query: readonly string[] } {
  const questionMark = target.indexOf("?");
  const rawPath = questionMark < 0 ? target : target.slice(0, questionMark);
  const query = questionMark < 0 ? [] : [...new Set(target.slice(questionMark + 1).split("&").map((pair) => pair.split("=")[0] ?? "").filter((name) => name !== ""))];
  const segments = rawPath.split("/");
  const path = segments
    .map((segment, index) => {
      if (UUID_SEGMENT.test(segment)) {
        return "{uuid}";
      }
      const prefixed = PREFIXED_ID_SEGMENT.exec(segment);
      if (prefixed !== null) {
        return `{${(prefixed[1] ?? "id").toLowerCase()}_id}`;
      }
      if (LONG_TOKEN_SEGMENT.test(segment)) {
        return "{id}";
      }
      if (MEMBER_ACTIONS.has(segments[index + 1] ?? "") && index > 0) {
        return "{name}";
      }
      return segment;
    })
    .join("/")
    .replace(REPO_ROUTE, "/code/repos/{owner}/{repo}");
  return { path, query: query.sort() };
}

type Leaf = "string" | "number" | "boolean" | "null";

/** Everything seen at one position of a shape: leaf types, string values, and the objects and array elements merged beneath it. */
interface Accumulator {
  readonly leaves: Set<Leaf>;
  readonly strings: Map<string, number>;
  stringSamples: number;
  samples: number;
  object: { readonly fields: Map<string, Accumulator>; count: number } | undefined;
  /** The merged values of every key of the objects that were maps, replacing their per-key fields in the shape. */
  mapValues: Accumulator | undefined;
  array: Accumulator | undefined;
}

function emptyAccumulator(): Accumulator {
  return { leaves: new Set(), strings: new Map(), stringSamples: 0, samples: 0, object: undefined, mapValues: undefined, array: undefined };
}

/** Adds one JSON value to the accumulator for its position. */
function observe(accumulator: Accumulator, value: unknown): void {
  accumulator.samples += 1;
  if (Array.isArray(value)) {
    accumulator.array ??= emptyAccumulator();
    for (const element of value) {
      observe(accumulator.array, element);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    accumulator.object ??= { fields: new Map(), count: 0 };
    accumulator.object.count += 1;
    const entries = Object.entries(value);
    if (entries.length > MAP_MIN_KEYS) {
      accumulator.mapValues ??= emptyAccumulator();
      for (const [, entry] of entries) {
        observe(accumulator.mapValues, entry);
      }
      return;
    }
    for (const [key, entry] of entries) {
      let field = accumulator.object.fields.get(key);
      if (field === undefined) {
        field = emptyAccumulator();
        accumulator.object.fields.set(key, field);
      }
      observe(field, entry);
    }
    return;
  }
  if (typeof value === "string") {
    accumulator.leaves.add("string");
    accumulator.stringSamples += 1;
    accumulator.strings.set(value, (accumulator.strings.get(value) ?? 0) + 1);
    return;
  }
  if (typeof value === "number") {
    accumulator.leaves.add("number");
  } else if (typeof value === "boolean") {
    accumulator.leaves.add("boolean");
  } else {
    accumulator.leaves.add("null");
  }
}

function stringLeaf(accumulator: Accumulator): string {
  const distinct = [...accumulator.strings.keys()];
  if (accumulator.stringSamples >= ENUM_MIN_SAMPLES && distinct.length <= ENUM_MAX_DISTINCT) {
    return distinct.sort().map((value) => JSON.stringify(value)).join("|");
  }
  return "string";
}

/** The accumulator as a shape: objects as objects (optional keys marked `?`), arrays as one-element arrays of the merged element, leaves as type names. */
function render(accumulator: Accumulator): unknown {
  const alternatives: unknown[] = [];
  for (const leaf of [...accumulator.leaves].sort()) {
    alternatives.push(leaf === "string" ? stringLeaf(accumulator) : leaf);
  }
  if (accumulator.array !== undefined) {
    alternatives.push([render(accumulator.array)]);
  }
  if (accumulator.mapValues !== undefined) {
    alternatives.push({ "<key>": render(accumulator.mapValues) });
  }
  if (accumulator.object !== undefined && accumulator.object.fields.size > 0) {
    const { fields, count } = accumulator.object;
    alternatives.push(Object.fromEntries([...fields].sort(([left], [right]) => left.localeCompare(right)).map(([key, field]) => [field.samples < count ? `${key}?` : key, render(field)])));
  }
  if (alternatives.length === 0) {
    return "unknown";
  }
  return alternatives.length === 1 ? alternatives[0] : alternatives;
}

/** One endpoint's merged observations. */
interface EndpointAccumulator {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly queryNames: Set<string>;
  readonly requestHeaders: Map<string, Set<string>>;
  readonly requestBody: Accumulator;
  requestBodies: number;
  readonly responses: Map<string, { count: number; readonly headers: Map<string, Set<string>>; readonly body: Accumulator; bodies: number; readonly nonJson: Set<string> }>;
  readonly websocket: Map<string, { readonly direction: WebSocketDirection; readonly kind: string; readonly body: Accumulator; count: number }>;
}

export interface EndpointSummary {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly samples: number;
  readonly query: readonly string[];
  readonly requestHeaders: Readonly<Record<string, readonly string[]>>;
  readonly request: unknown;
  readonly responses: readonly {
    readonly status: string;
    readonly samples: number;
    readonly headers: Readonly<Record<string, readonly string[]>>;
    readonly body: unknown;
    /** Content kinds of bodies that were not JSON (`text`, `binary`, `event-stream`) with their sample counts. */
    readonly nonJson: readonly string[];
  }[];
  /** For an upgraded WebSocket connection: each message group, named by direction and `kind` or `type` discriminator. */
  readonly websocket: readonly { readonly direction: WebSocketDirection; readonly kind: string; readonly samples: number; readonly body: unknown }[];
}

function methodAndTarget(request: HttpMessage): { readonly method: string; readonly target: string } {
  const [method = "", target = ""] = request.startLine.split(" ");
  return { method, target };
}

function headerNames(message: HttpMessage, into: Map<string, Set<string>>): void {
  for (const [name, value] of message.headers) {
    if (NOISE_HEADERS.has(name)) {
      continue;
    }
    let values = into.get(name);
    if (values === undefined) {
      values = new Set();
      into.set(name, values);
    }
    if (VALUED_HEADERS.has(name)) {
      values.add(value.split(";")[0]?.trim() ?? value);
    }
  }
}

/** The body as JSON, or a label for the kind of content it is when it is not. An incomplete or undecodable body is a label, never a guess. */
function bodyJson(message: HttpMessage): { readonly json: unknown } | { readonly label: string } | undefined {
  if (message.body.length === 0 && message.complete) {
    return undefined;
  }
  if (!message.complete) {
    return { label: "incomplete" };
  }
  const content = decodeContent(message);
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) {
    return { label: "binary" };
  }
  const contentType = message.headers.find(([name]) => name === "content-type")?.[1] ?? "";
  if (contentType.includes("text/event-stream")) {
    return { label: "event-stream" };
  }
  try {
    return { json: redactJson(JSON.parse(text)) };
  } catch {
    return { label: "text" };
  }
}

function websocketGroups(exchange: HttpExchange, endpoint: EndpointAccumulator): void {
  if (exchange.tail === undefined || exchange.request.headers.find(([name]) => name === "upgrade")?.[1]?.toLowerCase() !== "websocket") {
    return;
  }
  const negotiation = negotiationOf(exchange.response?.headers.find(([name]) => name === "sec-websocket-extensions")?.[1]);
  for (const [direction, stream] of [
    ["client_to_server", exchange.tail.client],
    ["server_to_client", exchange.tail.server],
  ] as const) {
    for (const message of decodeFrames(stream, direction, negotiation).messages) {
      let kind: string = message.kind;
      let json: unknown;
      if (message.kind === "text") {
        try {
          json = redactJson(JSON.parse(message.payload.toString("utf8")));
        } catch {
          json = undefined;
        }
        if (typeof json === "object" && json !== null && !Array.isArray(json)) {
          const discriminator = "kind" in json && typeof json.kind === "string" ? json.kind : "type" in json && typeof json.type === "string" ? json.type : undefined;
          kind = discriminator === undefined ? "text" : `text:${discriminator}`;
        }
      }
      const key = `${direction}|${kind}`;
      let group = endpoint.websocket.get(key);
      if (group === undefined) {
        group = { direction, kind, body: emptyAccumulator(), count: 0 };
        endpoint.websocket.set(key, group);
      }
      group.count += 1;
      if (json !== undefined) {
        observe(group.body, json);
      }
    }
  }
}

/** Folds the exchanges of a capture into one summary per host, method and normalised path, ordered by host, path, then method. */
export function summariseContracts(exchanges: readonly HttpExchange[]): EndpointSummary[] {
  const endpoints = new Map<string, EndpointAccumulator>();
  const samples = new Map<string, number>();
  for (const exchange of exchanges) {
    const { method, target } = methodAndTarget(exchange.request);
    const { path, query } = normaliseTarget(target);
    const key = `${exchange.host} ${method} ${path}`;
    let endpoint = endpoints.get(key);
    if (endpoint === undefined) {
      endpoint = { host: exchange.host, method, path, queryNames: new Set(), requestHeaders: new Map(), requestBody: emptyAccumulator(), requestBodies: 0, responses: new Map(), websocket: new Map() };
      endpoints.set(key, endpoint);
    }
    samples.set(key, (samples.get(key) ?? 0) + 1);
    for (const name of query) {
      endpoint.queryNames.add(name);
    }
    headerNames(exchange.request, endpoint.requestHeaders);
    const request = bodyJson(exchange.request);
    if (request !== undefined) {
      endpoint.requestBodies += 1;
      if ("json" in request) {
        observe(endpoint.requestBody, request.json);
      }
    }
    if (exchange.response !== undefined) {
      const status = exchange.response.startLine.split(" ")[1] ?? "";
      let response = endpoint.responses.get(status);
      if (response === undefined) {
        response = { count: 0, headers: new Map(), body: emptyAccumulator(), bodies: 0, nonJson: new Set() };
        endpoint.responses.set(status, response);
      }
      response.count += 1;
      headerNames(exchange.response, response.headers);
      const body = bodyJson(exchange.response);
      if (body !== undefined) {
        response.bodies += 1;
        if ("json" in body) {
          observe(response.body, body.json);
        } else {
          response.nonJson.add(body.label);
        }
      }
    }
    websocketGroups(exchange, endpoint);
  }
  const recordOf = (headers: Map<string, Set<string>>): Record<string, string[]> => Object.fromEntries([...headers].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, [...values].sort()]));
  return [...endpoints]
    .sort(([, left], [, right]) => left.host.localeCompare(right.host) || left.path.localeCompare(right.path) || left.method.localeCompare(right.method))
    .map(([key, endpoint]) => ({
      host: endpoint.host,
      method: endpoint.method,
      path: endpoint.path,
      samples: samples.get(key) ?? 0,
      query: [...endpoint.queryNames].sort(),
      requestHeaders: recordOf(endpoint.requestHeaders),
      request: endpoint.requestBodies === 0 ? undefined : render(endpoint.requestBody),
      responses: [...endpoint.responses]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, response]) => ({ status, samples: response.count, headers: recordOf(response.headers), body: response.bodies === 0 || response.body.samples === 0 ? undefined : render(response.body), nonJson: [...response.nonJson].sort() })),
      websocket: [...endpoint.websocket.values()].map((group) => ({ direction: group.direction, kind: group.kind, samples: group.count, body: group.body.samples === 0 ? undefined : render(group.body) })),
    }));
}

/** The summaries as text: one block per endpoint, request and response shapes as single-line JSON. */
export function renderContracts(summaries: readonly EndpointSummary[]): string {
  const blocks = summaries.map((summary) => {
    const lines = [`## ${summary.method} ${summary.host}${summary.path}  (${String(summary.samples)} sample${summary.samples === 1 ? "" : "s"})`];
    if (summary.query.length > 0) {
      lines.push(`query: ${summary.query.join(", ")}`);
    }
    const headers = Object.entries(summary.requestHeaders).map(([name, values]) => (values.length === 0 ? name : `${name}=${values.join("|")}`));
    if (headers.length > 0) {
      lines.push(`request headers: ${headers.join(", ")}`);
    }
    if (summary.request !== undefined) {
      lines.push(`request: ${JSON.stringify(summary.request)}`);
    }
    for (const response of summary.responses) {
      lines.push(`response ${response.status} (${String(response.samples)}): ${response.body === undefined ? "(no JSON body)" : JSON.stringify(response.body)}${response.nonJson.length === 0 ? "" : ` [${response.nonJson.join(", ")}]`}`);
    }
    for (const group of summary.websocket) {
      lines.push(`ws ${group.direction === "client_to_server" ? ">" : "<"} ${group.kind} (${String(group.samples)}): ${group.body === undefined ? "(no JSON body)" : JSON.stringify(group.body)}`);
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
