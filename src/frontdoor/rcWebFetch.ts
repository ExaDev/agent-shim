import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

import { HTTP_STATUS } from "../codex/http";
import { ExemptHttpAgent, ExemptTlsAgent } from "./connectEffects";

/**
 * The worker's web-fetch proxy target side: the URL fetch the CLI delegates to the Remote Control host when its environment sends `CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY`, served by the self-hosted surface so such a session does not break on the first fetch. The wire contract is the one the 2.1.289 CLI's own client half defines (its `THr`/`jPt` functions): a POST of `{url}` to `/{cse}/worker/web-fetch` answered with `{url, destination_url, text, content_type}` or `{error: {error_type, error_message}}`, read under a 12 MiB answer cap and a 40 s per-attempt timeout.
 *
 * This module owns the fetch's bounds; `rcSelfHost.ts` owns the serving. The bounds are derived, each from a fact of the protocol or the runtime, never chosen: the byte cap and the deadline are the CLI client's own reader limits (an answer past either is dropped unread, so there is no point delivering one), the redirect bound is the runtime fetch's own, and the private-address refusal is what every public proxy owes its host, lifted only by a named environment variable for deployments that deliberately serve internal targets (the interception rig is one).
 *
 * The real dial rides the door's own interception-proof agents (`connectEffects.ts`), so a fetch cannot be looped back into the door's transparent surface by the very redirect that surface serves, exactly like every other upstream dial the door makes.
 */

/** The largest answer the CLI's web proxy client reads: its request is built with `maxContentLength: 12582912`, so an answer past this is dropped unread by the client that asked for it. The door reads at most this many body bytes, and refuses the fetch rather than truncating, because the answer's shape carries no truncated flag a silent cut could hide behind. */
export const RC_WEB_FETCH_MAX_BYTES = 12_582_912;

/** The CLI's web proxy client timeout per attempt (`timeout: 40000` in its source): the door races the same budget so a slow target is answered as a target error inside the attempt the client is willing to wait for, rather than after it. */
export const RC_WEB_FETCH_DEADLINE_MS = 40_000;

/** The most redirects one fetch follows: the runtime's own `fetch` follows at most 20 (undici's documented default), so the proxy never walks a chain a plain fetch in the same process would refuse. */
export const RC_WEB_FETCH_MAX_REDIRECTS = 20;

/** The environment variable that lifts the private-address refusal, read once at door start like the mode variables beside it: an interception rig or an internal-network door deliberately serves loopback and RFC 1918 targets, and names that choice in its environment. Anything but `1` means the refusal stands. */
export const RC_WEB_FETCH_ALLOW_PRIVATE_ENV = "AGENT_SHIM_FRONTDOOR_RC_SELF_HOST_WEB_FETCH_ALLOW_PRIVATE";

/** Whether the environment lifted the private-address refusal for the worker's web-fetch proxy. */
export function rcWebFetchAllowsPrivateFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env[RC_WEB_FETCH_ALLOW_PRIVATE_ENV] === "1";
}

/** The user agent the door's fetch presents: its own name, not the CLI's, because this dial is the door acting as a proxy, not impersonating the client whose request it serves. */
const WEB_FETCH_USER_AGENT = "agent-shim-frontdoor";

/** The error type prefix every target refusal carries, so the CLI's tool error names which leg failed; the statuses below complete it. */
const ERROR_PREFIX = "web_fetch_";

/** The v4 first octets the refusal covers whole: "this network" (RFC 791), the RFC 1918 private interior, and loopback (RFC 1122). */
const V4_THIS_NETWORK_OCTET = 0;
const V4_PRIVATE_A_OCTET = 10;
const V4_LOOPBACK_OCTET = 127;

/** The shared CGNAT block 100.64/10 (RFC 6598), where overlay networks live: its first octet and the span of its second. */
const V4_CGNAT_OCTET = 100;
const V4_CGNAT_SECOND_FROM = 64;
const V4_CGNAT_SECOND_TO = 127;

/** Link-local 169.254/16 (RFC 3927). */
const V4_LINK_LOCAL_OCTET = 169;
const V4_LINK_LOCAL_SECOND = 254;

/** The private 172.16/12 span (RFC 1918). */
const V4_PRIVATE_B_OCTET = 172;
const V4_PRIVATE_B_SECOND_FROM = 16;
const V4_PRIVATE_B_SECOND_TO = 31;

/** The private 192.168/16 block (RFC 1918). */
const V4_PRIVATE_C_OCTET = 192;
const V4_PRIVATE_C_SECOND = 168;

/** Multicast and the reserved tail begin at this first octet (224/4, RFC 1112). */
const V4_MULTICAST_FROM_OCTET = 224;

/** The v6 unique-local block fc00::/7 (RFC 4193), by first hextet. */
const V6_UNIQUE_LOCAL_FROM = 0xfc00;
const V6_UNIQUE_LOCAL_TO = 0xfdff;

/** The v6 link-local block fe80::/10 (RFC 4291), by first hextet. */
const V6_LINK_LOCAL_FROM = 0xfe80;
const V6_LINK_LOCAL_TO = 0xfebf;

/** The v6 multicast block ff00::/8 (RFC 4291), by first hextet. */
const V6_MULTICAST_FROM = 0xff00;

/** The IP versions `net.isIP` names an address by. */
const IP_VERSION_4 = 4;
const IP_VERSION_6 = 6;

/** The redirect statuses the fetch follows: moved permanently, found, see other, and the two method-preserving temporaries (RFC 9110 section 15.4). */
const HTTP_MOVED_PERMANENTLY = 301;
const HTTP_FOUND = 302;
const HTTP_SEE_OTHER = 303;
const HTTP_TEMPORARY_REDIRECT = 307;
const HTTP_PERMANENT_REDIRECT = 308;

/** The end of the 2xx success span, exclusive. */
const SUCCESS_STATUS_MAX_EXCLUSIVE = 300;

/** One fetch's settled outcome: the fetched facts the serving half answers with, or the target refusal it answers instead. A refusal is a 200 answer with an `error` object (the protocol's own target-error channel), never an HTTP error status: the CLI retries 5xx answers, and a target that failed is not worth retrying as though the proxy were broken. */
export type RcWebFetchOutcome =
  | { readonly kind: "fetched"; readonly url: string; readonly destinationUrl: string; readonly contentType: string | undefined; readonly text: string }
  | { readonly kind: "refused"; readonly errorType: string; readonly errorMessage: string };

/** The fetch the self-hosted surface calls for one worker web-fetch request. */
export type RcWebFetcher = (url: string) => Promise<RcWebFetchOutcome>;

/** One dial's answer as the bounds logic sees it: status and headers settled, the body still streaming, so the read cap can cut it mid-flight. */
export interface RcWebFetchHop {
  readonly status: number;
  /** The redirect target when the status carries one, exactly as the header named it (possibly relative). */
  readonly location: string | undefined;
  readonly contentType: string | undefined;
  readonly chunks: AsyncIterable<Uint8Array>;
}

/** Everything one fetch needs, injected so the bounds run against fakes in unit tests: one dial per already-checked URL, one hostname resolution, the private-address stance, and the deadline budget. */
export interface RcWebFetchDeps {
  readonly dial: (url: URL, signal: AbortSignal) => Promise<RcWebFetchHop>;
  /** Resolves one hostname to every address it answers with; the refusal judges them all, so a name whose any address is private is refused. */
  readonly lookup: (hostname: string) => Promise<readonly string[]>;
  readonly allowPrivate: boolean;
  readonly deadlineMs: number;
}

/** The refusal every outcome error is spelled with. */
function refused(errorType: string, errorMessage: string): RcWebFetchOutcome {
  return { kind: "refused", errorType: `${ERROR_PREFIX}${errorType}`, errorMessage };
}

/** Whether an address is one this proxy refuses unless the deployment lifted the rule: the address blocks that reach a machine's own interfaces or its private interior. Loopback, the RFC 1918 and RFC 4193 interiors, link-local, the shared CGNAT block (which overlay networks live in), unspecified, and multicast: each names a target a public URL fetch has no business reaching, and a hostname resolving to any of them is refused whole. */
export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === IP_VERSION_4) {
    const octets = address.split(".").map((part) => Number(part));
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    if (first === V4_THIS_NETWORK_OCTET || first === V4_PRIVATE_A_OCTET || first === V4_LOOPBACK_OCTET) {
      return true;
    }
    if (first === V4_CGNAT_OCTET && second >= V4_CGNAT_SECOND_FROM && second <= V4_CGNAT_SECOND_TO) {
      return true;
    }
    if (first === V4_LINK_LOCAL_OCTET && second === V4_LINK_LOCAL_SECOND) {
      return true;
    }
    if (first === V4_PRIVATE_B_OCTET && second >= V4_PRIVATE_B_SECOND_FROM && second <= V4_PRIVATE_B_SECOND_TO) {
      return true;
    }
    if (first === V4_PRIVATE_C_OCTET && second === V4_PRIVATE_C_SECOND) {
      return true;
    }
    return first >= V4_MULTICAST_FROM_OCTET;
  }
  if (version === IP_VERSION_6) {
    const lower = address.toLowerCase();
    // A v4-mapped address is judged as the address it carries.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped !== null) {
      return isPrivateAddress(mapped[1] ?? "");
    }
    if (lower === "::" || lower === "::1") {
      return true;
    }
    const firstGroup = Number.parseInt((/^([0-9a-f]+):/.exec(lower)?.[1] ?? "0"), 16);
    if (Number.isNaN(firstGroup)) {
      return true;
    }
    if (firstGroup >= V6_UNIQUE_LOCAL_FROM && firstGroup <= V6_UNIQUE_LOCAL_TO) {
      return true;
    }
    if (firstGroup >= V6_LINK_LOCAL_FROM && firstGroup <= V6_LINK_LOCAL_TO) {
      return true;
    }
    return firstGroup >= V6_MULTICAST_FROM;
  }
  // Not an address at all: fail closed, because the refusal rule judges addresses and this is not one it can clear.
  return true;
}

/** Whether a status is a 2xx success. */
function isSuccessful(status: number): boolean {
  return status >= HTTP_STATUS.ok && status < SUCCESS_STATUS_MAX_EXCLUSIVE;
}

/** Whether a redirect status is one the fetch follows. */
function isRedirect(status: number): boolean {
  return status === HTTP_MOVED_PERMANENTLY || status === HTTP_FOUND || status === HTTP_SEE_OTHER || status === HTTP_TEMPORARY_REDIRECT || status === HTTP_PERMANENT_REDIRECT;
}

/**
 * Whether a content type's bytes can honestly travel as the answer's `text`: the readable families (text, JSON, XML, scripts, YAML, CSV) decode as the UTF-8 they were served as, while anything else (an image, a font) would arrive as lossy garbage under a content_type that claims otherwise.
 */
function readableContentType(contentType: string | undefined): boolean {
  if (contentType === undefined || contentType.trim() === "") {
    // No content type named: the client's own default reads it as text/plain, so the door does too.
    return true;
  }
  const normalised = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const slash = normalised.indexOf("/");
  const main = slash === -1 ? normalised : normalised.slice(0, slash);
  const sub = slash === -1 ? "" : normalised.slice(slash + 1);
  if (main === "text") {
    return true;
  }
  return /json|xml|javascript|ecmascript|yaml|csv/.test(sub);
}

/** Reads one hop's body under the byte cap, either to its text or to the refusal a body past the cap earns. */
async function readCapped(chunks: Readonly<AsyncIterable<Uint8Array>>): Promise<{ readonly tooLarge: boolean; readonly text: string }> {
  const collected: Buffer[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (total > RC_WEB_FETCH_MAX_BYTES) {
      return { tooLarge: true, text: "" };
    }
    collected.push(Buffer.from(chunk));
  }
  return { tooLarge: false, text: Buffer.concat(collected).toString("utf8") };
}

/** Checks one URL the fetch is about to dial: the scheme the proxy speaks, and the target's addresses against the private-address stance. Resolves undefined when the dial may go ahead. */
async function checkTarget(url: URL, deps: Readonly<RcWebFetchDeps>): Promise<RcWebFetchOutcome | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refused("scheme", `the web-fetch proxy dials http and https only, not ${url.protocol}`);
  }
  if (deps.allowPrivate) {
    return undefined;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  try {
    addresses = net.isIP(hostname) === 0 ? await deps.lookup(hostname) : [hostname];
  } catch {
    return refused("resolve", `${hostname} did not resolve`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return refused("private_address", `${hostname} resolves to ${address}, a private address this web-fetch proxy refuses; set ${RC_WEB_FETCH_ALLOW_PRIVATE_ENV}=1 on the door if serving internal targets is intended`);
    }
  }
  return undefined;
}

/** Runs one fetch through its bounds: scheme and address checks on every hop, the redirect walk, the content-type gate, the byte cap and the deadline. */
export async function fetchThroughWebProxy(url: string, deps: Readonly<RcWebFetchDeps>): Promise<RcWebFetchOutcome> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return refused("malformed_url", `${url} is not a URL this proxy can dial`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.deadlineMs);
  timer.unref();
  try {
    let redirects = 0;
    for (;;) {
      const refusal = await checkTarget(current, deps);
      if (refusal !== undefined) {
        return refusal;
      }
      let hop: RcWebFetchHop;
      try {
        hop = await deps.dial(current, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          return refused("deadline", `the fetch of ${url} did not settle within its deadline`);
        }
        return refused("transport", `the dial of ${current.toString()} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      if (isRedirect(hop.status) && hop.location !== undefined) {
        if (redirects >= RC_WEB_FETCH_MAX_REDIRECTS) {
          controller.abort();
          return refused("too_many_redirects", `${url} followed more than ${String(RC_WEB_FETCH_MAX_REDIRECTS)} redirects without settling`);
        }
        let next: URL;
        try {
          next = new URL(hop.location, current);
        } catch {
          controller.abort();
          return refused("malformed_url", `a redirect of ${current.toString()} named ${hop.location}, which is not a URL this proxy can dial`);
        }
        // The redirect's own body is drained under the same cap before the next dial, so a redirect cannot leave a held socket or stall the walk on a body nobody reads.
        const drained = await readCapped(hop.chunks);
        if (drained.tooLarge) {
          controller.abort();
          return refused("too_large", `the body of a redirect from ${url} exceeds the ${String(RC_WEB_FETCH_MAX_BYTES)} byte cap the CLI's proxy client reads`);
        }
        redirects += 1;
        current = next;
        continue;
      }
      if (!isSuccessful(hop.status)) {
        controller.abort();
        return refused("status", `the target answered HTTP ${String(hop.status)} for ${current.toString()}`);
      }
      const contentType = hop.contentType ?? "";
      if (!readableContentType(contentType)) {
        controller.abort();
        return refused("content_type", `the target at ${current.toString()} served a ${contentType} answer, which the proxy's text field cannot carry`);
      }
      const read = await readCapped(hop.chunks);
      if (read.tooLarge) {
        controller.abort();
        return refused("too_large", `the body of ${current.toString()} exceeds the ${String(RC_WEB_FETCH_MAX_BYTES)} byte cap the CLI's proxy client reads`);
      }
      return { kind: "fetched", url, destinationUrl: current.toString(), contentType: hop.contentType, text: read.text };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The production fetch: one plain and one TLS agent of the door's own exempt kind, shared across fetches so connections pool, with every dial carrying the abort signal the bounds own. Hostname resolution is the system resolver (`dns.lookup`, all addresses), which is also the stance the refusal judges; the dial itself routes through the exempt agents, whose real-name dials resolve upstreams through real DNS and the pf-exempt source-port range, so a fetch cannot be looped back into the door's own transparent surface by the interception it serves.
 */
export function realRcWebFetch(options: { readonly allowPrivate: boolean }): RcWebFetcher {
  const plainAgent = new ExemptHttpAgent();
  const tlsAgent = new ExemptTlsAgent();
  const deps: RcWebFetchDeps = {
    dial: async (url, signal) =>
      await new Promise<RcWebFetchHop>((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(
          {
            hostname: url.hostname,
            port: url.port === "" ? undefined : Number(url.port),
            method: "GET",
            path: `${url.pathname}${url.search}`,
            headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": WEB_FETCH_USER_AGENT },
            agent: url.protocol === "https:" ? tlsAgent : plainAgent,
            signal,
          },
          (response) => {
            const location = response.headers.location;
            resolve({
              status: response.statusCode ?? 0,
              location: typeof location === "string" ? location : undefined,
              contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : undefined,
              chunks: response,
            });
          },
        );
        request.once("error", reject);
        request.end();
      }),
    lookup: async (hostname) => (await dns.promises.lookup(hostname, { all: true })).map((entry) => entry.address),
    allowPrivate: options.allowPrivate,
    deadlineMs: RC_WEB_FETCH_DEADLINE_MS,
  };
  return async (url) => await fetchThroughWebProxy(url, deps);
}
