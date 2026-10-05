import type { IncomingMessage, ServerResponse } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { isLiveCapability } from "./capability";
import type { PrePipelineApi } from "./server";

/**
 * The door's self-hosted Remote Control web client: one hand-written page, inline script and style, no dependencies and no build step, served by the provider listener behind the same per-generation control token as the typed API. The browser speaks the door's existing oRPC RPC protocol directly with `fetch` (POST `{"json": ...}` envelopes, and the `text/event-stream` body of `events.subscribe` parsed by hand), so no client library is shipped and the REST/OpenAPI mount (#224) stays unfired: its trigger is TLS pinning making a browser client awkward, and plain `fetch` over the door's own origin is not that.
 *
 * Token handling, the one honest shape a browser allows: a navigation cannot carry an Authorization header, so the page's own GET accepts this generation's token either as the Bearer header every other surface takes (what `fetch` callers and tests present) or as a `?token=` query parameter, the single way a pasted URL authenticates. The served HTML never contains the token; the page script reads it from its own URL at load, keeps it in memory and per-tab `sessionStorage`, and strips it from the address bar. Every API call then presents it as a Bearer header, never in a URL again.
 */

/** The one path the page is served at, outside the routed URL space like the typed API's prefix, and deliberately not under `/__agent-shim/rc` (the bespoke control routes' prefix, which would swallow it). */
export const RC_CLIENT_PATH = "/__agent-shim/client";

/**
 * The page's script, as its own constant beside the HTML that carries it: the page's tests evaluate exactly this text outside a browser (see `rcClientPage.test.ts`), so what they drive is the shipped script and not a copy. Written without template literals so it can live inside one, and defining its helpers as plain top-level functions that boot only when a `document` exists, which is what makes that evaluation possible.
 */
export const RC_CLIENT_PAGE_SCRIPT = `'use strict';
// The door's typed API as this page speaks it: the oRPC RPC protocol over plain fetch, which is one POST per procedure with a {"json": input} body and a {"json": output} answer, so no client library is needed. These helpers are plain top-level functions (not boot-scoped) so the page's tests can evaluate this script outside a browser and drive them against a mounted listener.
var API_PREFIX = '/__agent-shim/orpc';
var TOKEN_KEY = 'agent-shim-rc-token';
var token = null;

function apiBase() { return window.location.origin + API_PREFIX; }

// Calls one procedure: resolves the output's own value, rejects with the door's error message when it answered one.
async function rpc(path, input) {
  var response = await fetch(apiBase() + '/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ json: input === undefined ? {} : input }),
  });
  var envelope = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    var message = envelope && envelope.json && envelope.json.message ? envelope.json.message : ('HTTP ' + response.status);
    var error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return envelope.json;
}

// Parses every complete SSE frame out of the buffered text, returning the frames and the unparsed remainder. Comment frames (the door's keepalive opens with one) carry no event name and are dropped.
function parseSseFrames(buffer) {
  var frames = [];
  var rest = buffer;
  for (;;) {
    var boundary = rest.indexOf('\\n\\n');
    if (boundary === -1) { break; }
    var raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    var frame = { event: 'message', id: '', data: '' };
    var lines = raw.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '' || line.charAt(0) === ':') { continue; }
      var colon = line.indexOf(':');
      var field = colon === -1 ? line : line.slice(0, colon);
      var value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.charAt(0) === ' ') { value = value.slice(1); }
      if (field === 'event') { frame.event = value; }
      if (field === 'id') { frame.id = value; }
      if (field === 'data') { frame.data += (frame.data === '' ? '' : '\\n') + value; }
    }
    if (frame.data !== '') { frames.push(frame); }
  }
  return { frames: frames, rest: rest };
}

// Whether one source-tagged event continues the per-source sequence the tracker holds: the count of events the stream dropped when it does not, zero when it does. The tracker keeps the high-water mark, so a number the door re-sends after a reconnect is a duplicate, not a step back, and never reports a negative gap. The backbone holds no replay, so a gap is reported, never hidden.
function sequenceGap(tracker, event) {
  var previous = tracker[event.source];
  if (event.sequence > (previous === undefined ? 0 : previous)) { tracker[event.source] = event.sequence; }
  if (previous === undefined || event.sequence <= previous) { return 0; }
  return event.sequence - previous - 1;
}

function shortId(id) { return id.length > 14 ? id.slice(0, 8) + '..' + id.slice(-4) : id; }

// A bounded sketch of any payload, the feed's fallback rendering: one JSON line, cut with a marker rather than silently.
function sketch(value, cap) {
  var text;
  try { text = JSON.stringify(value); } catch (e) { text = String(value); }
  if (text === undefined) { text = 'undefined'; }
  return text.length > cap ? text.slice(0, cap) + '...' : text;
}

// The headline text of one Remote Control stream event: the assistant and user payloads that carry a content array of text blocks render as their prose, everything else as its type plus a sketch.
function rcLine(event) {
  var envelope = event.envelope;
  var payload = envelope.payload;
  var headline = '';
  if (payload !== undefined && payload !== null && typeof payload === 'object' && Array.isArray(payload.content)) {
    var parts = [];
    for (var i = 0; i < payload.content.length; i++) {
      var block = payload.content[i];
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') { parts.push(block.text); }
    }
    if (parts.length > 0) { headline = parts.join(' '); }
  }
  if (headline === '') {
    headline = envelope.event_type;
    if (payload !== undefined) { headline += '  ' + sketch(payload, 240); }
  }
  return new Date().toLocaleTimeString() + '  ' + shortId(event.session) + '  ' + envelope.event_type + '  ' + headline;
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) { node.className = className; }
  if (text !== undefined) { node.textContent = text; }
  return node;
}

var ui = null;

function renderEvent(event, gap) {
  if (ui === null) { return; }
  var list = ui.eventList;
  if (gap > 0) {
    list.appendChild(el('div', 'event gap', 'dropped events: ' + String(gap) + ' on source ' + event.source + ' (the stream holds no replay)'));
  }
  var line;
  if (event.source === 'rc') {
    line = rcLine(event.payload);
  } else {
    line = new Date().toLocaleTimeString() + '  [' + event.source + ']  ' + sketch(event.payload, 240);
  }
  list.appendChild(el('div', 'event', line));
  while (list.childElementCount > 500) { list.removeChild(list.firstChild); }
  list.scrollTop = list.scrollHeight;
}

function renderSessions(statuses) {
  if (ui === null) { return; }
  var list = ui.sessionList;
  list.textContent = '';
  if (statuses.length === 0) {
    list.appendChild(el('div', 'event dim', 'no Remote Control sessions observed'));
    return;
  }
  for (var i = 0; i < statuses.length; i++) {
    var status = statuses[i];
    var worker = status.workerState === undefined ? 'worker unknown' : 'worker ' + status.workerState.value;
    var row = el('div', 'session' + (status.id === ui.selected ? ' selected' : ''));
    row.appendChild(el('div', null, shortId(status.id)));
    row.appendChild(el('div', 'dim', worker + (status.pending.length === 0 ? '' : ', ' + String(status.pending.length) + ' pending') + ', seen ' + new Date(status.lastSeenAt).toLocaleTimeString()));
    row.addEventListener('click', selectSession(status.id));
    list.appendChild(row);
  }
}

function selectSession(id) {
  return function () {
    if (ui === null) { return; }
    ui.selected = ui.selected === id ? null : id;
    ui.promptTarget.textContent = ui.selected === null ? 'no session selected' : 'to ' + ui.selected;
    refreshSessions();
    refreshPending();
  };
}

function renderPending(pending) {
  if (ui === null) { return; }
  var list = ui.pendingList;
  list.textContent = '';
  if (pending.length === 0) {
    list.appendChild(el('div', 'event dim', 'no control requests awaiting an answer'));
    return;
  }
  for (var i = 0; i < pending.length; i++) {
    var request = pending[i];
    var card = el('div', 'card');
    card.appendChild(el('div', null, request.type + '  ' + (request.summary === '' ? shortId(request.requestId) : request.summary)));
    card.appendChild(el('div', 'dim', shortId(request.sessionId) + '  ' + shortId(request.requestId) + '  observed ' + new Date(request.observedAt).toLocaleTimeString()));
    var row = el('div', 'row');
    var denial = el('input');
    denial.type = 'text';
    denial.placeholder = 'denial message (optional)';
    var approve = el('button', null, 'Approve');
    var deny = el('button', 'secondary', 'Deny');
    approve.addEventListener('click', answerRequest(request, true, denial));
    deny.addEventListener('click', answerRequest(request, false, denial));
    row.appendChild(denial);
    row.appendChild(approve);
    row.appendChild(deny);
    card.appendChild(row);
    list.appendChild(card);
  }
}

function answerRequest(request, approve, denialInput) {
  return function () {
    var input = { session: request.sessionId, request: request.requestId, approve: approve };
    if (!approve && denialInput.value !== '') { input.text = denialInput.value; }
    rpc('rc/answer', input).then(function () {
      renderEvent({ source: 'page', sequence: 0, payload: { note: (approve ? 'approved' : 'denied') + ' ' + request.requestId } }, 0);
      refreshPending();
    }, function (error) { window.alert('answer failed: ' + error.message); });
  };
}

function sendPrompt() {
  if (ui === null || ui.selected === null) { window.alert('select a session first'); return; }
  var text = ui.prompt.value;
  if (text === '') { return; }
  ui.send.disabled = true;
  rpc('rc/send', { session: ui.selected, text: text }).then(function (result) {
    ui.prompt.value = '';
    renderEvent({ source: 'page', sequence: 0, payload: { note: 'sent, sequence_num ' + result.sequenceNums.join(', ') } }, 0);
  }, function (error) { window.alert('send failed: ' + error.message); }).then(function () { ui.send.disabled = false; });
}

function refreshSessions() {
  rpc('rc/status', {}).then(function (result) { renderSessions(result.statuses); }, authOrReport('rc/status'));
}

function refreshPending() {
  rpc('rc/pending', ui !== null && ui.selected !== null ? { session: ui.selected } : {}).then(function (result) { renderPending(result.pending); }, authOrReport('rc/pending'));
}

// The one error path every call shares: a 401 means this token is not this generation's, so the page says so and asks for it again; anything else is reported in the feed.
function authOrReport(what) {
  return function (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    renderEvent({ source: 'page', sequence: 0, payload: { note: what + ' failed: ' + error.message } }, 0);
  };
}

function handleUnauthorized() {
  window.sessionStorage.removeItem(TOKEN_KEY);
  if (feedAbort !== null) { feedAbort.abort(); }
  streamState('');
  showTokenForm('this door refused the token: it names a different door generation, paste the current one');
}

function streamState(text) { if (ui !== null) { ui.streamState.textContent = text; } }

var feedAbort = null;

// Subscribes to the door's backbone and renders what it yields, reconnecting on any drop. The stream holds no replay, so a reconnect starts at the live head and the per-source sequence numbers surface whatever the gap swallowed.
async function runFeed() {
  var tracker = {};
  for (;;) {
    if (feedAbort !== null) { feedAbort.abort(); }
    feedAbort = new AbortController();
    var filter = document.getElementById('source-filter').value;
    var input = filter === '' ? {} : { sources: [filter] };
    try {
      streamState('stream: connecting');
      var response = await fetch(apiBase() + '/events/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ json: input }),
        signal: feedAbort.signal,
      });
      if (response.status === 401) { handleUnauthorized(); return; }
      if (!response.ok || response.body === null) { throw new Error('HTTP ' + String(response.status)); }
      streamState('stream: live');
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) { break; }
        buffer += decoder.decode(chunk.value, { stream: true });
        var parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (var i = 0; i < parsed.frames.length; i++) {
          var frame = parsed.frames[i];
          if (frame.event !== 'message') { continue; }
          var event;
          try { event = JSON.parse(frame.data).json; } catch (e) { continue; }
          if (event === undefined || event.source === undefined) { continue; }
          renderEvent(event, sequenceGap(tracker, event));
        }
      }
    } catch (error) {
      if (feedAbort !== null && feedAbort.signal.aborted) { return; }
    }
    streamState('stream: dropped, reconnecting');
    await new Promise(function (resolve) { window.setTimeout(resolve, 1000); });
  }
}

function showTokenForm(message) {
  if (feedAbort !== null) { feedAbort.abort(); }
  if (ui !== null) { ui.main.classList.add('hidden'); }
  var form = document.getElementById('token-form');
  form.classList.remove('hidden');
  document.getElementById('token-error').textContent = message === undefined ? '' : message;
  document.getElementById('token-input').focus();
}

function startPage(heldToken) {
  token = heldToken;
  ui = {
    main: document.getElementById('main'),
    eventList: document.getElementById('event-list'),
    sessionList: document.getElementById('session-list'),
    pendingList: document.getElementById('pending-list'),
    prompt: document.getElementById('prompt'),
    promptTarget: document.getElementById('prompt-target'),
    send: document.getElementById('send'),
    streamState: document.getElementById('stream-state'),
    selected: null,
  };
  document.getElementById('token-form').classList.add('hidden');
  ui.main.classList.remove('hidden');
  document.getElementById('refresh').addEventListener('click', function () { refreshSessions(); refreshPending(); });
  document.getElementById('send').addEventListener('click', sendPrompt);
  document.getElementById('source-filter').addEventListener('change', function () { runFeed(); });
  ui.prompt.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { sendPrompt(); }
  });
  refreshSessions();
  refreshPending();
  window.setInterval(function () { refreshSessions(); refreshPending(); }, 4000);
  runFeed();
  document.getElementById('door-state').textContent = 'connected';
}

function boot() {
  var held = null;
  var query = new URLSearchParams(window.location.search);
  var fromQuery = query.get('token');
  if (fromQuery !== null && fromQuery !== '') {
    window.sessionStorage.setItem(TOKEN_KEY, fromQuery);
    // The token leaves the address bar the moment the page holds it, so a refresh or a shared screen shows the clean URL; sessionStorage keeps the tab working.
    window.history.replaceState(null, '', window.location.pathname);
    held = fromQuery;
  } else {
    held = window.sessionStorage.getItem(TOKEN_KEY);
  }
  document.getElementById('token-save').addEventListener('click', function () {
    var value = document.getElementById('token-input').value.trim();
    if (value === '') { return; }
    window.sessionStorage.setItem(TOKEN_KEY, value);
    startPage(value);
  });
  document.getElementById('token-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { document.getElementById('token-save').click(); }
  });
  if (held !== null && held !== '') { startPage(held); }
}

if (typeof document !== 'undefined' && document.getElementById('event-list') !== null) {
  window.addEventListener('DOMContentLoaded', boot);
}
`;

/**
 * The page itself, one static string so serving it needs no filesystem read and the bundle carries it: hand-written, no external resource of any kind, every dynamic value rendered through `textContent` so nothing that crossed the door is ever parsed as markup.
 */
export const RC_CLIENT_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-shim Remote Control</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #101418; color: #d7dde3; font: 14px/1.45 ui-monospace, Menlo, Consolas, monospace; }
  header { display: flex; gap: 12px; align-items: baseline; padding: 10px 16px; background: #171d24; border-bottom: 1px solid #2a333d; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .state { color: #8b98a5; }
  main { display: flex; gap: 1px; background: #2a333d; min-height: calc(100vh - 39px); }
  section { background: #101418; padding: 12px 16px; overflow-y: auto; }
  #sessions { flex: 0 0 320px; border-right: 1px solid #2a333d; }
  #right { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #feed { flex: 1; }
  #controls { border-top: 1px solid #2a333d; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b98a5; margin: 8px 0 8px; font-weight: 600; }
  .session { padding: 6px 8px; border: 1px solid transparent; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session:hover { background: #171d24; }
  .session.selected { border-color: #3d6ea5; background: #17222e; }
  .session .dim { color: #8b98a5; }
  .event { padding: 2px 0; white-space: pre-wrap; word-break: break-word; }
  .event .dim { color: #8b98a5; }
  .event.gap { color: #d29922; }
  .event.error { color: #e5534b; }
  textarea, input[type=text], select { background: #171d24; color: #d7dde3; border: 1px solid #2a333d; border-radius: 4px; padding: 6px 8px; font: inherit; width: 100%; }
  textarea { resize: vertical; min-height: 44px; }
  button { background: #1f4a7a; color: #d7dde3; border: 1px solid #3d6ea5; border-radius: 4px; padding: 5px 12px; font: inherit; cursor: pointer; }
  button.secondary { background: #2a333d; border-color: #3a444f; }
  button:disabled { opacity: 0.5; cursor: default; }
  .row { display: flex; gap: 8px; margin: 6px 0; align-items: center; }
  .card { border: 1px solid #3d6ea5; border-radius: 4px; padding: 8px; margin: 6px 0; background: #17222e; }
  .card .dim { color: #8b98a5; }
  #token-form { max-width: 480px; margin: 48px auto; }
  #token-form p { color: #8b98a5; }
  .hidden { display: none !important; }
</style>
</head>
<body data-agent-shim-rc-client>
<header>
  <h1>agent-shim Remote Control</h1>
  <span class="state" id="door-state">connecting</span>
  <span class="state" id="stream-state"></span>
</header>
<div id="token-form">
  <h2>This door's control token</h2>
  <p>The page is served behind the door's per-generation control token. Paste this door generation's token (the owner-only value the door writes beside its state) to use the page; it stays in this tab only.</p>
  <div class="row"><input type="text" id="token-input" placeholder="control token" autocomplete="off"><button id="token-save">Use</button></div>
  <p id="token-error" class="event error"></p>
</div>
<main class="hidden" id="main">
  <section id="sessions">
    <h2>Sessions <button class="secondary" id="refresh">Refresh</button></h2>
    <div id="session-list"></div>
  </section>
  <section id="right">
    <div id="feed">
      <h2>Feed <select id="source-filter"><option value="">all sources</option><option value="rc">Remote Control only</option></select></h2>
      <div id="event-list"></div>
    </div>
    <div id="controls">
      <h2>Pending approvals</h2>
      <div id="pending-list"></div>
      <h2>Send a prompt</h2>
      <div class="row"><textarea id="prompt" placeholder="Prompt for the selected session"></textarea></div>
      <div class="row"><span class="dim" id="prompt-target">no session selected</span><span style="flex:1"></span><button id="send">Send</button></div>
    </div>
  </section>
</main>
<script>
${RC_CLIENT_PAGE_SCRIPT}
</script>
</body>
</html>
`;

/**
 * The token the page's own GET presents: the Bearer header every other token-gated surface takes, or the `?token=` query parameter, the one credential a browser navigation can carry. Both are checked in constant time against this generation's value.
 */
function pageTokenOf(request: IncomingMessage, url: URL): string | undefined {
  const presented = request.headers.authorization;
  const bearerPrefix = "bearer ".length;
  const header = typeof presented === "string" && presented.slice(0, bearerPrefix).toLowerCase() === "bearer " ? presented.slice(bearerPrefix) : undefined;
  const query = url.searchParams.get("token") ?? undefined;
  return header ?? query;
}

/** Serves one request under the page's prefix: the page at the prefix itself, the door's own 404 for any deeper path, and 405 with the allowed methods for anything but GET or HEAD. */
function serveRcClientPage(expectedToken: string, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "https://door.invalid");
  if (url.pathname !== RC_CLIENT_PATH && url.pathname !== `${RC_CLIENT_PATH}/`) {
    response.writeHead(HTTP_STATUS.notFound, { "Content-Type": "text/plain" });
    response.end("no such page under the door's client prefix");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(HTTP_STATUS.methodNotAllowed, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
    response.end("the door's web client page is read-only");
    return;
  }
  const token = pageTokenOf(request, url);
  if (token === undefined || !isLiveCapability(token, [expectedToken])) {
    // The same refusal shape the typed API answers with, so a caller probing the page learns nothing beyond the gate itself.
    response.writeHead(HTTP_STATUS.unauthorized, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "the door's web client demands this generation's control token, as a Bearer credential or the token query parameter" }));
    return;
  }
  // No store (the page is per-door and tiny) and no referrer (nothing here may leave the door's origin), and a CSP that admits only this page's own inline script, style and same-origin fetches: the page loads no external resource by construction, and the policy holds that construction.
  response.writeHead(HTTP_STATUS.ok, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  });
  response.end(request.method === "HEAD" ? undefined : RC_CLIENT_PAGE_HTML);
}

/**
 * Builds the page's pre-pipeline surface for the provider listener: the same dispatch contract as the typed API's mount (the prefix, the not-matched 404 the listener answers), one path serving one static page behind the same per-generation control token.
 */
export function createRcClientPage(expectedToken: string): PrePipelineApi {
  return {
    pathPrefix: RC_CLIENT_PATH,
    handle: async (request, response) => {
      serveRcClientPage(expectedToken, request, response);
      // Serving the page is one synchronous write; the yielded turn lets it flush before the dispatch resolves.
      await Promise.resolve();
      return { matched: true };
    },
  };
}
