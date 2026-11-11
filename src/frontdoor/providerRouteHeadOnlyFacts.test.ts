import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
/** Bytes of padding between a body's head and what follows it: past the 64 KiB a head scan reads. */
const PAD_BYTES = 200_000;
/** The size of the chunks the body arrives in, so the scan's head stops at the cap and what follows is never seen. */
const CHUNK_BYTES = 16_384;
const MAX_TOKENS_THRESHOLD = 100;
const MAX_TOKENS_VALUE = 5000;

/** What one whole-body fact looks like in a body, and the route that asks for it. `route` sends a request to `cheap` when the fact reads `matches`. */
interface Fact {
  readonly name: string;
  /** The JSON fields (each with its leading comma) that carry the fact. */
  readonly fields: string;
  readonly when: unknown;
  /** Whether the route matches when the fact is present, as against absent. */
  readonly matchesWhenPresent: boolean;
}

const IMAGE_MESSAGES = ',"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]';
const reference = (key: string): unknown => ({ kind: "reference", key });
const FACTS: readonly Fact[] = [
  { name: "hasImage", fields: IMAGE_MESSAGES, when: { kind: "compare", op: "eq", left: reference("request.hasImage"), right: { kind: "booleanLiteral", value: false } }, matchesWhenPresent: false },
  { name: "toolsPresent", fields: ',"tools":[{"name":"t","input_schema":{"type":"object"}}]', when: { kind: "compare", op: "eq", left: reference("request.toolsPresent"), right: { kind: "booleanLiteral", value: false } }, matchesWhenPresent: false },
  { name: "thinking", fields: ',"thinking":{"type":"enabled","budget_tokens":1024}', when: { kind: "compare", op: "eq", left: reference("request.thinking"), right: { kind: "booleanLiteral", value: false } }, matchesWhenPresent: false },
  { name: "maxTokens", fields: `,"max_tokens":${String(MAX_TOKENS_VALUE)}`, when: { kind: "compare", op: "gt", left: reference("request.maxTokens"), right: { kind: "numberLiteral", value: MAX_TOKENS_THRESHOLD } }, matchesWhenPresent: true },
];

type Position = "head" | "past the head" | "absent";
const POSITIONS: readonly Position[] = ["head", "past the head", "absent"];
type Kind = "a Messages request" | "a count_tokens request" | "a batch" | "a file upload";
const PATHS: readonly (readonly [Kind, string, boolean])[] = [
  ["a Messages request", "/v1/messages", true],
  ["a count_tokens request", "/v1/messages/count_tokens", true],
  ["a batch", "/v1/messages/batches", false],
  ["a file upload", "/v1/files", false],
];

/** A provider `main` with one route that sends a request to `cheap` when `when` holds. */
function resolverWith(when: unknown): ReturnType<typeof createProviderRouteResolver> {
  const stub = recordingFetch(() => {
    throw new Error("no upstream call");
  });
  const main = { displayName: "Main", baseUrl: "http://127.0.0.1:1", credential: { sources: [{ literal: "t" }] }, routes: [{ when, provider: "cheap" }] };
  return createProviderRouteResolver({
    fs: fakeFs({ [`${PROVIDERS_DIR}/main.json`]: main, [`${PROVIDERS_DIR}/cheap.json`]: { displayName: "Cheap", baseUrl: "http://127.0.0.1:2", credential: { sources: [{ literal: "t" }] } } }),
    providersDir: PROVIDERS_DIR,
    codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: stub.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
    directPort: () => 1,
    env: {},
    credentials: fakeAsyncCredentials(),
    log: () => undefined,
    now: () => 0,
    mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
  });
}

/** A POST whose body has the model first, then `fact` in the head, past it or nowhere. */
function postOf(path: string, fact: Fact, position: Position): RoutedRequest {
  const body = `{"model":"claude-sonnet-5-5"${position === "head" ? fact.fields : ""},"pad":"${"x".repeat(PAD_BYTES)}"${position === "past the head" ? fact.fields : ""}}`;
  const chunks = Array.from({ length: Math.ceil(body.length / CHUNK_BYTES) }, (_unused, index) => Buffer.from(body.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)));
  return { method: "POST", url: `/providers/main${path}`, headers: {}, body: Readable.from(chunks), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
}

async function routedTo(request: RoutedRequest, when: unknown): Promise<string> {
  const resolution = await resolverWith(when)(request);
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }
  return resolution.route.name;
}

describe("a fact read off the text of the body is decided from the whole body, and from a head only when the head matched", () => {
  const rows = FACTS.flatMap((fact) => PATHS.flatMap(([kind, path, messages]) => POSITIONS.map((position) => ({ name: fact.name, kind, position, fact, path, messages }))));
  it.each(rows)("$name on $kind, the fact $position", async ({ fact, path, messages, position }) => {
    // The whole-body decision is the fact's presence anywhere; a head decides only what it shows, and says nothing about an absence.
    const decided = messages || position === "head" ? position !== "absent" : undefined;
    const expectedMatch = decided !== undefined && decided === fact.matchesWhenPresent;
    expect(await routedTo(postOf(path, fact, position), fact.when)).toBe(expectedMatch ? "http:cheap" : "http:main");
  });
});
