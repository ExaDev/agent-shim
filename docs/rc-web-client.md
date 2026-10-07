# The self-hosted Remote Control web client

The door serves a small web page that gives claude.ai-style control of its Remote Control sessions from a browser: the session list with each session's worker state, a live event feed (assistant replies and pending approvals above all), prompt sending, and approval answering. It is the client half issue #207's design named and scoped out: with the door serving the CCR surface itself in self-hosted mode, this page is the "attached client" a person uses, and no Anthropic credential is involved anywhere.

## Where it is and how it authenticates

The page is served by the door's provider listener, the same listener that serves the typed API, at:

```
https://127.0.0.1:<provider port>/__agent-shim/client
```

The provider port is the one `agent-shim frontdoor status` reports. The page sits behind the same per-generation control token as every other operator surface of the door, so there is no extra process and no new trust surface: whoever can read the owner-only token file can already drive the whole door, and nobody else can reach the page at all.

A browser navigation cannot carry an `Authorization` header, so the page's own GET accepts the token one of two ways:

- as the Bearer header every other surface takes (what `fetch` callers and the tests present), or
- as a `?token=` query parameter, the single way a pasted URL authenticates.

The served HTML never contains the token. The page's script reads it from its own URL at load, keeps it in memory and per-tab `sessionStorage` only, and strips it from the address bar (`history.replaceState`), so a refresh keeps working while the visible URL and any screenshot stay clean. Every API call the page makes presents the token as a Bearer header, never in a URL again. A refused token (the door restarted, so the generation changed) returns the page to its token prompt.

## How the page talks to the door

The page speaks the door's existing typed API directly, with no client library: the oRPC RPC protocol is one `POST` per procedure with a `{"json": input}` body and a `{"json": output}` answer, and `events.subscribe` answers `text/event-stream`, which the page parses by hand. It stays on the RPC protocol rather than the mount's REST routes because plain `fetch` from the page's own origin already works; the REST/OpenAPI surface serves consumers with no TypeScript client, and its entry point is the OpenAPI document at `/__agent-shim/orpc/openapi.json` (same control token), with the routes themselves under `/rest`. The page is one hand-written HTML file (`src/frontdoor/rcClientPage.ts`), inline script and style, no build step and no external resource of any kind; a CSP header admits only the page's own inline script, its style and same-origin fetches.

What the page drives:

- `rc/status` (all sessions): the session list, refreshed on a short poll and on demand.
- `events.subscribe` (every source, or an `rc`-only filter): the live feed. Reconnects on any drop; because the door's event backbone holds no replay, a reconnect starts at the live head, and the per-source sequence numbers surface whatever the gap swallowed as a visible "dropped events" line rather than hiding it.
- `rc/send`: the prompt box, to the selected session.
- `rc/pending` (the selected session, or all): the approval cards.
- `rc/answer`: each card's Approve and Deny (with an optional denial message).

Remote Control events render their envelope: payloads that carry a content array of text blocks (assistant and user messages) render as their prose, everything else as its event type plus a bounded JSON sketch. Steering beyond this (interrupt, model, permission mode) stays on the CLI verbs, which the door already serves; the page is a control surface, not an app.

## Serving and testing

The page's route is a pre-pipeline surface of the provider listener exactly like the typed API's mount (`createRcClientPage` in `src/frontdoor/rcClientPage.ts`, wired in `src/frontdoor/commands.ts`), dispatched by the listener's shared prefix matching. The page's script is one constant the module also exports, so the tests evaluate the shipped script itself (not a copy) outside a browser and drive its protocol helpers against a mounted listener: the unit suite (`rcClientPage.test.ts`) covers the token gate (unauthenticated refused, Bearer and `?token=` served, HEAD, 405, deeper paths 404), the page's own `rpc()` against a real node handler, the SSE frame parser (keepalive comments, frames split across chunks) and the sequence-gap arithmetic; the e2e suite (`rcClientPage.e2e.test.ts`) mounts the page beside the merged typed API on the door's real TLS and drives exactly the calls the page makes, including a live `events.subscribe` stream read with the page's own parser.

On the rig (see [docs/rc-interception-rig.md](rc-interception-rig.md)), the page is the browser surface of the self-hosted proof: serve it from the door, hand the browser `https://127.0.0.1:<provider port>/__agent-shim/client?token=<this generation's token>`, and the page lists the rig's Remote Control sessions, streams their events, and carries prompts and approvals, with the door's CA trusted the way the rig's other clients trust it.
