import type { IncomingHttpHeaders } from "node:http";

/**
 * The request headers that carry a session's provider credential: Claude Code sends `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer ...` and `ANTHROPIC_API_KEY` as `x-api-key`, the two credential targets a provider can name.
 */
const CREDENTIAL_HEADERS: readonly string[] = ["authorization", "x-api-key"];

/** What stands in for a credential while its request crosses headroom: an opaque word that authenticates nothing anywhere. */
export const SEQUESTERED_CREDENTIAL = "agent-shim-sequestered";

/** The credential headers one custody record holds, exactly as the client sent them. */
type HeldCredentials = Readonly<Record<string, string | readonly string[]>>;

/** One request's headers with its credentials swapped out, and the id that redeems them. */
interface Sequestered {
  readonly hopId: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * Holds a provider session's real credentials in this process's memory while its request takes the headroom hop, so the credential never crosses headroom or the plain-HTTP leg back to the door.
 *
 * The hop calls `sequester`, sends headroom the placeholder headers plus the hop id, and calls `release` once its response to the client has finished or the client has gone. The direct listener calls `redeem` with the hop id and the provider its request path names: a live id recorded for that same provider yields the real headers, anything else yields nothing and the request is refused. A process that binds the direct port therefore receives only placeholders and an id that is worthless once the hop ends, and nothing outside this process can mint an id.
 *
 * An id stays redeemable for the whole hop rather than exactly once, because headroom legitimately sends one client request upstream more than once: it retries 429, 529 and 5xx answers, and its memory-tool and CCR continuations call the upstream again inside the same client turn, all with the headers it was handed.
 */
export interface CredentialCustody {
  /** Takes custody of `headers`' credential headers for one hop to `provider`, returning the headers to send headroom (placeholders where the credentials were) and the hop id that redeems them. */
  readonly sequester: (headers: Readonly<IncomingHttpHeaders>, provider: string) => Sequestered;
  /** Ends a hop: its id stops redeeming. Idempotent. */
  readonly release: (hopId: string) => void;
  /** The real credential headers for a live hop to `provider`, or undefined for an unknown, released or mismatched id. */
  readonly redeem: (hopId: string, provider: string) => HeldCredentials | undefined;
}

/** The placeholder one credential header's value becomes: an Authorization value keeps its scheme, so headroom still sees the request's auth shape (`Bearer ...`) without the secret. */
function placeholderFor(name: string, value: string | readonly string[]): string {
  const first = typeof value === "string" ? value : (value[0] ?? "");
  if (name === "authorization") {
    const space = first.indexOf(" ");
    return space === -1 ? SEQUESTERED_CREDENTIAL : `${first.slice(0, space)} ${SEQUESTERED_CREDENTIAL}`;
  }
  return SEQUESTERED_CREDENTIAL;
}

/** Creates an empty custody store. `randomId` must be unguessable (a v4 UUID or better): the id is the only thing that redeems a credential. */
export function createCredentialCustody(randomId: () => string): CredentialCustody {
  const held = new Map<string, { readonly provider: string; readonly credentials: HeldCredentials }>();
  return {
    sequester: (headers, provider) => {
      const hopId = randomId();
      const outgoing: Record<string, string | string[] | undefined> = {};
      const credentials: Record<string, string | readonly string[]> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) {
          continue;
        }
        const lower = name.toLowerCase();
        if (CREDENTIAL_HEADERS.includes(lower)) {
          credentials[lower] = value;
          outgoing[name] = placeholderFor(lower, value);
          continue;
        }
        outgoing[name] = value;
      }
      held.set(hopId, { provider, credentials });
      return { hopId, headers: outgoing };
    },
    release: (hopId) => {
      held.delete(hopId);
    },
    redeem: (hopId, provider) => {
      const record = held.get(hopId);
      return record?.provider === provider ? record.credentials : undefined;
    },
  };
}

/**
 * The headers a redeemed request is routed with: every credential header headroom forwarded (placeholders, or anything else headroom chose to send) is dropped, and the held originals take their place. Whatever the hop's request carried in those headers is never trusted; only what the client sent is.
 */
export function restoreCredentials(headers: Readonly<IncomingHttpHeaders>, credentials: HeldCredentials): IncomingHttpHeaders {
  const restored: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !CREDENTIAL_HEADERS.includes(name.toLowerCase())) {
      restored[name] = value;
    }
  }
  for (const [name, value] of Object.entries(credentials)) {
    restored[name] = typeof value === "string" ? value : [...value];
  }
  return restored;
}
