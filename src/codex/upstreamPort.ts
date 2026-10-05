import type { HeaderReader } from "./quota";

/** The request half of an outbound HTTP call, the subset of the Fetch API's `RequestInit` the codex route and the sign-in flow send. */
export interface UpstreamRequestInit {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** The request body; absent for a GET. */
  readonly body?: string;
  readonly signal: AbortSignal;
}

/** The response half: the subset of the Fetch API's `Response` the codex route reads. */
export interface UpstreamResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: HeaderReader;
  /** The streamed body, or null when the response has none. */
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

/**
 * One outbound HTTP call, injected so the translator, the auth store and the route are testable with no network. The real implementation is undici's `fetch` over a dispatcher with a bounded keep-alive (see `createUpstreamFetch`).
 */
export type UpstreamFetch = (url: string, init: UpstreamRequestInit) => Promise<UpstreamResponse>;
