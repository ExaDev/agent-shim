#!/usr/bin/env node
// The rig's OAuth-capable MCP server, for the live proof of the mcp_authenticate and mcp_oauth_callback_url Remote Control control verbs (docs/rc-interception-rig.md). It is a streamable-HTTP MCP server whose single tool is protected by a full OAuth 2.0 authorization-code flow with PKCE that this same listener serves: the well-known protected-resource and authorization-server metadata, dynamic client registration, an authorization endpoint that auto-approves consent (so no human and no browser is needed; the proof plays the browser with one redirect-manual fetch) and a token endpoint. Every value in the flow is synthetic and throwaway (client ids, codes, tokens: rig- prefixed fillers minted at run time); nothing here is or carries a real secret. The CLI's MCP OAuth support is HTTP-transport only ("Server type ... does not support OAuth authentication" for stdio, verified in the 2.1.289 bundle), so the rig's stdio MCP server cannot host this and this server exists beside it. Rig-only; not part of the published package. Usage: node scripts/rc-mcp-oauth-server.mts [--port 47480] [--log <file>]; the port defaults to RC_OAUTH_PORT and the log file to RC_OAUTH_LOG, and the log names fingerprints of the synthetic credentials it mints, never a value.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 47480;
const MCP_PATH = "/mcp";
const WELL_KNOWN_RESOURCE = "/.well-known/oauth-protected-resource";
const WELL_KNOWN_AS = "/.well-known/oauth-authorization-server";
const DEFAULT_LOG_FILE = "/tmp/rig-oauth-log.jsonl";
/** How many hex characters of a digest the log names: enough to tell two synthetic values apart, never enough to be one. */
const FINGERPRINT_CHARS = 12;
/** How many random bytes each minted filler carries: 96 bits, far beyond any need for a synthetic value. */
const MINT_RANDOM_BYTES = 12;
/** How many leading bytes of a connection the diagnostic log names in hex: enough to tell a TLS ClientHello (16 03 ...) from an HTTP request line, never a full request. */
const FIRST_BYTES_LOGGED = 12;
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_ID = "rig-oauth-client";
const CLIENT_SECRET = "rig-synthetic-client-secret";
/** One minute in milliseconds, the unit the code lifetime is expressed in. */
const MINUTE_MS = 60_000;
/** How many minutes an authorization code stays exchangeable at /token after /authorize mints it. */
const CODE_TTL_MINUTES = 10;
/** One second in milliseconds, for the epoch seconds the registration answer stamps. */
const MS_PER_SECOND = 1000;
/** How many seconds the token answer claims for its synthetic access tokens; the rig never waits one out. */
const TOKEN_LIFETIME_S = 3600;
/** How many characters of a client-error message the log keeps: enough to name the failure, never a full request. */
const CLIENT_ERROR_CHARS = 160;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_ACCEPTED = 202;
/** 302 Found, the redirect that carries the authorization code back to the redirect URI. */
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_NOT_FOUND = 404;

/** The one tool this server serves, described exactly as tools/list must answer it. */
const TOOLS = [
  {
    name: "rig_secret",
    description: "Returns the rig's OAuth-protected marker; answers only when the call carries an access token this server's token endpoint minted.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

/** One authorization code /authorize has issued and /token has not yet exchanged. */
interface IssuedCode {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAt: number;
}

/** The slice of a JSON-RPC message this server decides on: the method name, the id that makes it a request rather than a notification, and the params the method may carry. */
interface McpMessage {
  readonly method: string;
  readonly id: unknown;
  readonly params: Readonly<Record<string, unknown>> | undefined;
}

/** Authorization codes issued by /authorize and not yet exchanged. */
const codes = new Map<string, IssuedCode>();
/** Access tokens minted by /token that /mcp accepts. Never printed; the log carries fingerprints only. */
const accessTokens = new Set<string>();
/** Refresh tokens issued, mapped to nothing (rotation is not part of the proof); present only so a refresh round answers. */
const refreshTokens = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcpMessage(value: unknown): McpMessage | undefined {
  if (!isRecord(value) || typeof value.method !== "string") {
    return undefined;
  }
  return { method: value.method, id: value.id, params: isRecord(value.params) ? value.params : undefined };
}

function argument(name: string, fallback: string): string {
  const flag = process.argv.indexOf(`--${name}`);
  return flag !== -1 && flag + 1 < process.argv.length ? (process.argv[flag + 1] ?? fallback) : fallback;
}

const port = Number(argument("port", process.env.RC_OAUTH_PORT ?? String(DEFAULT_PORT)));
const logFile = argument("log", process.env.RC_OAUTH_LOG ?? DEFAULT_LOG_FILE);
const origin = `http://${HOST}:${String(port)}`;

/** A one-way fingerprint of a synthetic credential, so the log names which value arrived without ever printing one. */
function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, FINGERPRINT_CHARS);
}

/** Appends one event to the rig log as a JSON line; disposable rig evidence, never committed. */
function log(entry: Readonly<Record<string, unknown>>): void {
  fs.appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

/** Mints one throwaway value (a code, a token) from the rig's prefix; nothing here is or derives from a real secret. */
function mint(prefix: string): string {
  return `${prefix}-${randomBytes(MINT_RANDOM_BYTES).toString("hex")}`;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(HTTP_UNAUTHORIZED, {
    "content-type": "application/json",
    // The MCP authorization spec's challenge: the resource_metadata URL is what the client's auth flow discovers the authorization server through.
    "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}${WELL_KNOWN_RESOURCE}"`,
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: this MCP server requires an OAuth access token from its synthetic authorization server." } }));
}

/** The method name of a request body, for the one log line the 401 path writes before the body is parsed; empty when the body is not a JSON-RPC request. */
function messageMethodOf(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isRecord(parsed) && typeof parsed.method === "string" ? parsed.method : "";
  } catch {
    return "";
  }
}

/** The MCP request half, answered only for bearers this server minted. */
function mcpResult(message: McpMessage, token: string): Record<string, unknown> | undefined {
  if (message.method === "initialize") {
    const requested = message.params !== undefined && typeof message.params.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL_VERSION;
    return { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: "rig-mcp-oauth", version: "1.0.0" } };
  }
  if (message.method === "tools/list") {
    return { tools: TOOLS };
  }
  if (message.method === "tools/call") {
    const name = message.params !== undefined && typeof message.params.name === "string" ? message.params.name : "";
    if (name !== "rig_secret") {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: `rig oauth secret served; the bearer presented fingerprints ${fingerprint(token)}` }] };
  }
  if (message.method === "ping") {
    return {};
  }
  return undefined;
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname;
    const rawBody = Buffer.concat(chunks).toString("utf8");

    // The authorization server surface: plain metadata and registration, no credential anywhere.
    if (req.method === "GET" && path === WELL_KNOWN_RESOURCE) {
      log({ kind: "protected-resource-metadata" });
      sendJson(res, HTTP_OK, { resource: `${origin}${MCP_PATH}`, authorization_servers: [origin], scopes_supported: ["mcp"] });
      return;
    }
    if (req.method === "GET" && path === WELL_KNOWN_AS) {
      log({ kind: "authorization-server-metadata" });
      sendJson(res, HTTP_OK, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        scopes_supported: ["mcp"],
      });
      return;
    }
    if (req.method === "POST" && path === "/register") {
      let requested: string[] = [];
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (isRecord(parsed) && Array.isArray(parsed.redirect_uris)) {
          requested = parsed.redirect_uris.filter((value: unknown): value is string => typeof value === "string");
        }
      } catch {
        // An unparseable registration is still answered: the rig's client is known and synthetic.
      }
      log({ kind: "dynamic-registration", redirectUris: requested });
      sendJson(res, HTTP_CREATED, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, client_id_issued_at: Math.floor(Date.now() / MS_PER_SECOND), client_secret_expires_at: 0, redirect_uris: requested.length > 0 ? requested : [`${origin}/callback`], client_name: "rig-oauth-client", token_endpoint_auth_method: "none" });
      return;
    }
    if (req.method === "GET" && path === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      const responseType = url.searchParams.get("response_type") ?? "";
      // Loopback redirect targets only: the rig's discipline even for synthetic values.
      const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(redirectUri);
      if (responseType !== "code" || !loopback) {
        log({ kind: "authorize-refused", responseType, redirectUri, reason: responseType !== "code" ? "response_type" : "non-loopback redirect_uri" });
        sendJson(res, HTTP_BAD_REQUEST, { error: "invalid_request", error_description: "the rig's synthetic AS authorizes response_type=code with a loopback redirect_uri only" });
        return;
      }
      const code = mint("rig-synthetic-code");
      codes.set(code, { redirectUri, codeChallenge, expiresAt: Date.now() + CODE_TTL_MINUTES * MINUTE_MS });
      const separator = redirectUri.includes("?") ? "&" : "?";
      const location = `${redirectUri}${separator}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      log({ kind: "authorize-autoapproved", redirectUri, state, codeFingerprint: fingerprint(code), pkce: codeChallenge !== "" ? "S256" : "none" });
      res.writeHead(HTTP_FOUND, { location, "content-length": "0" });
      res.end();
      return;
    }
    if (req.method === "POST" && path === "/token") {
      const params = new URLSearchParams(rawBody);
      const grantType = params.get("grant_type") ?? "";
      if (grantType === "refresh_token") {
        const presented = params.get("refresh_token") ?? "";
        if (!refreshTokens.has(presented)) {
          log({ kind: "token-refused", grantType, reason: "unknown refresh_token" });
          sendJson(res, HTTP_BAD_REQUEST, { error: "invalid_grant" });
          return;
        }
        const access = mint("rig-synthetic-access");
        accessTokens.add(access);
        log({ kind: "token-refreshed", accessFingerprint: fingerprint(access) });
        sendJson(res, HTTP_OK, { access_token: access, token_type: "Bearer", expires_in: TOKEN_LIFETIME_S, scope: "mcp" });
        return;
      }
      if (grantType !== "authorization_code") {
        log({ kind: "token-refused", grantType, reason: "unsupported grant_type" });
        sendJson(res, HTTP_BAD_REQUEST, { error: "unsupported_grant_type" });
        return;
      }
      const code = params.get("code") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const verifier = params.get("code_verifier") ?? "";
      const issued = codes.get(code);
      codes.delete(code);
      const validRedirect = issued?.redirectUri === redirectUri;
      const unexpired = issued !== undefined && Date.now() <= issued.expiresAt;
      const validPkce = issued !== undefined && (issued.codeChallenge === "" || (verifier !== "" && base64url(createHash("sha256").update(verifier).digest()) === issued.codeChallenge));
      if (!validRedirect || !unexpired || !validPkce) {
        log({ kind: "token-refused", grantType, reason: !validRedirect ? "redirect_uri mismatch" : !unexpired ? "code expired" : "PKCE verification failed", codeFingerprint: fingerprint(code) });
        sendJson(res, HTTP_BAD_REQUEST, { error: "invalid_grant", error_description: "the rig's synthetic AS requires the exact redirect_uri, a live code and the S256 verifier" });
        return;
      }
      const access = mint("rig-synthetic-access");
      const refresh = mint("rig-synthetic-refresh");
      accessTokens.add(access);
      refreshTokens.add(refresh);
      log({ kind: "token-issued", redirectUri, accessFingerprint: fingerprint(access), refreshFingerprint: fingerprint(refresh) });
      sendJson(res, HTTP_OK, { access_token: access, token_type: "Bearer", expires_in: TOKEN_LIFETIME_S, refresh_token: refresh, scope: "mcp" });
      return;
    }
    if (req.method === "GET" && path === "/callback") {
      // The landing the 302 aims at. Nothing needs to serve it (the proof reads the Location header and hands the full URL to the door's mcp-oauth-callback-url write), but a body here makes a followed redirect readable instead of an error.
      log({ kind: "callback-landed", query: [...url.searchParams.keys()] });
      sendJson(res, HTTP_OK, { note: "rig OAuth callback landing; the proof hands this URL to the door's mcp-oauth-callback-url write rather than following it" });
      return;
    }

    // The MCP resource surface: everything here answers 401 with the WWW-Authenticate challenge until a minted bearer arrives.
    if (path === MCP_PATH) {
      if (req.method !== "POST") {
        // The streamable-HTTP transport's GET stream and DELETE session termination are optional; refusing both with 405 is the spec's own answer.
        res.writeHead(HTTP_METHOD_NOT_ALLOWED, { allow: "POST", "content-length": "0" });
        res.end();
        return;
      }
      const authorization = req.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
      if (token === "" || !accessTokens.has(token)) {
        log({ kind: "mcp-unauthorized", method: messageMethodOf(rawBody), tokenFingerprint: token === "" ? "none" : fingerprint(token) });
        unauthorized(res);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        sendJson(res, HTTP_BAD_REQUEST, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (!isRecord(parsed) || parsed.id === undefined) {
        // Notifications carry no id and expect no answer.
        log({ kind: "mcp-notification", method: isRecord(parsed) && typeof parsed.method === "string" ? parsed.method : "" });
        res.writeHead(HTTP_ACCEPTED, { "content-length": "0" });
        res.end();
        return;
      }
      const message = parseMcpMessage(parsed);
      if (message === undefined) {
        sendJson(res, HTTP_BAD_REQUEST, { jsonrpc: "2.0", id: parsed.id, error: { code: -32600, message: "Invalid Request" } });
        return;
      }
      const result = mcpResult(message, token);
      log({ kind: "mcp-served", method: message.method, tokenFingerprint: fingerprint(token) });
      const reply = result === undefined ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } } : { jsonrpc: "2.0", id: message.id, result };
      sendJson(res, HTTP_OK, reply);
      return;
    }

    log({ kind: "not-found", method: req.method ?? "", path });
    res.writeHead(HTTP_NOT_FOUND, { "content-length": "0" });
    res.end();
  });
});

server.on("connection", (socket) => {
  // Diagnostic for the rig: the CLI's MCP fetch has been observed connecting without any HTTP request arriving; logging the first bytes distinguishes a TLS ClientHello (16 03 ...) from an HTTP request line, without ever logging a full request (and every credential this server ever sees is its own synthetic filler).
  let first = true;
  socket.on("data", (chunk: Buffer) => {
    if (first) {
      first = false;
      log({ kind: "connection-first-bytes", hex: chunk.subarray(0, FIRST_BYTES_LOGGED).toString("hex"), length: chunk.length });
    }
  });
});
server.on("clientError", (error, socket) => {
  log({ kind: "http-client-error", error: error.message.slice(0, CLIENT_ERROR_CHARS) });
  socket.destroy();
});

server.listen(port, HOST, () => {
  console.log(`rig OAuth MCP server listening on ${origin} (MCP at ${MCP_PATH}; synthetic AS in the same listener; log ${logFile})`);
  log({ kind: "started", origin });
});
