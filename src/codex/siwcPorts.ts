import { randomBytes } from "node:crypto";

import type { SiwcPorts } from "./siwc";
import type { UpstreamFetch } from "./upstreamPort";

/** The real primitives the Sign in with ChatGPT flow draws on: the process's own fetch, the operating system's random source and the wall clock. */
export function realSiwcPorts(fetch: UpstreamFetch): SiwcPorts {
  return { fetch, randomBytes: (size) => randomBytes(size), now: () => new Date() };
}
