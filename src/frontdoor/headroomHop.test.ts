import { randomUUID } from "node:crypto";
import { NO_ROUTING_SETTING } from "../headroom/routingSetting";
import { createHeadroomDecision } from "./headroomDecision";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fetch } from "undici";
import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "../codex/http";
import { HEADROOM_SOCKET_DIR_MODE } from "../headroom/socket";
import { writeHeadroomState } from "../headroom/state";
import { realFarmFs } from "../realPorts";
import { SEQUESTERED_CREDENTIAL } from "./custody";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, HOP_ID_HEADER, HOP_SECRET_HEADER, IDENTITY_HEADER, SESSION_HEADER } from "./route";
import { PROVIDERS_DIR, KEYGEN_TIMEOUT_MS, HOP_SECRET, PROVIDER_TOKEN, CLIENT_PRESENTED_BEARER, CLIENT_PRESENTED_KEY, SETTLE_MS, HOP_ROUTED_TIMEOUT_MS, MESSAGES_BODY, SUPERVISOR_PID, WORLD_DIR_MODE, STREAM_EVENTS, LAUNCH_TOKEN, fakeHeadroom, home, listenOnHeadroomSocket, closeServer, trusting, startDoor, fakeProviderUpstream, httpProvider, ROUTER_TO_CODEX, codexProvider, settle } from "./headroomHopTestWorld";

describe("the headroom hop", () => {
  it("sits before the translator: headroom receives the Anthropic-shaped request, and the translator serves what headroom forwards back through the direct listener", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting,
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: MESSAGES_BODY,
      });
      if (response.status !== HTTP_STATUS.ok) {
        throw new Error(`door answered ${String(response.status)}: ${await response.text()}`);
      }
      const body = (await response.json()) as { readonly content?: readonly { readonly text?: string }[] };
      expect(body.content?.[0]?.text).toBe("Hello");
      // Exactly one headroom request, exactly one codex upstream call: the loop through the direct listener cannot double-apply anything.
      expect(headroom.seen()).toHaveLength(1);
      const seen = headroom.seen()[0];
      expect(seen?.url).toBe("/providers/codex/v1/messages");
      expect(JSON.parse(seen?.body ?? "{}")).toMatchObject({ model: "claude-sonnet-4-5" });
      expect(seen?.headers["x-headroom-base-url"]).toBe(`http://127.0.0.1:${String(door.directPort())}`);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("carries the model name the request's own body carried to the client-facing observers, so a choice a translator made behind the hop can still be recognised", async () => {
    const headroom = await fakeHeadroom();
    const requested: (string | undefined)[] = [];
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, responseObservers: [(event) => {
      requested.push(event.requestedModel);
      return undefined;
    }] });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting,
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: MESSAGES_BODY,
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(requested).toEqual(["claude-sonnet-4-5"]);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("hands headroom the whole body of a request a provider's routes read and redirected, and serves the target the hop forwards back", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/router.json`]: ROUTER_TO_CODEX, [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      const response = await fetch(`${door.url}/providers/router/v1/messages`, {
        dispatcher: trusting,
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: MESSAGES_BODY,
        signal: AbortSignal.timeout(HOP_ROUTED_TIMEOUT_MS),
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(headroom.seen()).toHaveLength(1);
      expect(headroom.seen()[0]?.url).toBe("/providers/codex/v1/messages");
      expect(JSON.parse(headroom.seen()[0]?.body ?? "{}")).toMatchObject({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] });
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("follows a daemon recorded only under the previous release's legacy state name", async () => {
    const headroom = await fakeHeadroom();
    // The record moves to the legacy name, the shape a draining previous-generation supervisor serves under: the hop must still resolve and dial the daemon.
    fs.rmSync(home.paths.headroomStateFile, { force: true });
    writeHeadroomState(realFarmFs, home.paths.headroomLegacyStateFile, { supervisorPid: SUPERVISOR_PID, headroomPid: SUPERVISOR_PID + 1, socketPath: home.socketPath });
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting,
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: MESSAGES_BODY,
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(headroom.seen()).toHaveLength(1);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("re-sets the project identity on the hop, replacing any inbound copy, and never forwards headroom's own session header, which opts a session into mid-turn queueing", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting,
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, "x-headroom-project-id": "/repo", "x-headroom-session-id": "spoofed-by-the-client" },
        body: MESSAGES_BODY,
      });
      const seen = headroom.seen()[0];
      expect(seen?.headers["x-headroom-project-id"]).toBe("/repo");
      expect(seen?.headers["x-headroom-session-id"]).toBeUndefined();
      // The client sent no session header of its own, so the launch's id stands in for it under Claude Code's name.
      expect(seen?.headers["x-claude-code-session-id"]).toBe("session-1");
      // A client that identifies itself keeps its own id.
      await fetch(`${door.url}/providers/codex/v1/messages`, { dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, "x-claude-code-session-id": "the-clients-own" }, body: MESSAGES_BODY });
      expect(headroom.seen()[1]?.headers["x-claude-code-session-id"]).toBe("the-clients-own");
      expect(seen?.headers[IDENTITY_HEADER]).toBeUndefined();
      expect(seen?.headers[SESSION_HEADER]).toBeUndefined();
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("answers 502 rather than bypassing headroom while the daemon is between restarts", async () => {
    // Nothing is recorded as serving: the state file names no socket.
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    } finally {
      await door.close();
    }
  });

  it("serves a session that wants headroom directly when no daemon is serving, instead of answering 502", async () => {
    // Nothing is recorded as serving: the state file names no socket.
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomDecision: createHeadroomDecision(() => NO_ROUTING_SETTING) });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.ok);
    } finally {
      await door.close();
    }
  });

  it("sends a session that wants headroom through a daemon that reports itself ready", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomDecision: createHeadroomDecision(() => NO_ROUTING_SETTING) });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(headroom.seen()).toHaveLength(1);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("cancels the daemon's request the moment the client disconnects, which is what stops the daemon's work", async () => {
    let hopArrived: () => void = () => undefined;
    let daemonRequestEnded: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      hopArrived = resolve;
    });
    const ended = new Promise<void>((resolve) => {
      daemonRequestEnded = resolve;
    });
    // This headroom never answers: it holds the request open, so the daemon's side of it ends only when the door tears the hop down.
    const server = http.createServer((_request, response) => {
      response.on("close", daemonRequestEnded);
      hopArrived();
    });
    await listenOnHeadroomSocket(server);
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      const abort = new AbortController();
      const pending = fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY, signal: abort.signal });
      await arrived;
      abort.abort();
      await pending.then(
        () => undefined,
        () => undefined,
      );
      await ended;
    } finally {
      await door.close();
      await closeServer(server);
    }
  });

  it("logs a hop cut short by the client's disconnect as a request nobody was waiting on, once, naming that no response had started", async () => {
    let hopArrived: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      hopArrived = resolve;
    });
    const server = http.createServer(() => {
      hopArrived();
    });
    await listenOnHeadroomSocket(server);
    const logged: string[] = [];
    let resolveFailure: () => void = () => undefined;
    const failureLogged = new Promise<void>((resolve) => {
      resolveFailure = resolve;
    });
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      log: (line) => {
        logged.push(line);
        if (line.includes("headroom hop")) resolveFailure();
      },
    });
    try {
      const abort = new AbortController();
      const pending = fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY, signal: abort.signal });
      await arrived;
      abort.abort();
      await pending.then(
        () => undefined,
        () => undefined,
      );
      await failureLogged;
      const failures = logged.filter((line) => line.includes("headroom hop"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("before the response started");
      expect(failures[0]).toContain("first attempt, client had gone");
    } finally {
      await door.close();
      await closeServer(server);
    }
  });

  it("logs a hop that fails while the client is still waiting, naming the request and that no response had started", async () => {
    // A daemon that died without removing its socket: the socket file is still there, owner-only, but nothing listens on it. A hard link keeps the socket's inode after the server unlinks its own path on close.
    const dead = http.createServer();
    await listenOnHeadroomSocket(dead);
    const leftover = `${home.socketPath}.leftover`;
    fs.linkSync(home.socketPath, leftover);
    await closeServer(dead);
    fs.renameSync(leftover, home.socketPath);
    const logged: string[] = [];
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      log: (line) => {
        logged.push(line);
      },
    });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      const failures = logged.filter((line) => line.includes("headroom hop"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("POST /providers/codex/v1/messages");
      expect(failures[0]).toContain("before the response started");
      expect(failures[0]).toContain("first attempt, client still waiting");
    } finally {
      await door.close();
    }
  });

  it("says a response it cannot read is unreadable, not that the daemon is unreachable", async () => {
    // A header block past the client's size limit is rejected by the HTTP parser, which is a daemon that answered, not one that is down.
    const oversized = http.createServer((_request, response) => {
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json", "x-oversized": "a".repeat(http.maxHeaderSize * 2) });
      response.end("{}");
    });
    await listenOnHeadroomSocket(oversized);
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      const unreadable = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(unreadable.status).toBe(HTTP_STATUS.badGateway);
      const unreadableMessage = JSON.stringify(await unreadable.json());
      expect(unreadableMessage).toContain("sent a response the front door could not read");
      expect(unreadableMessage).toContain("HPE_HEADER_OVERFLOW");
      expect(unreadableMessage).not.toContain("unreachable");
    } finally {
      await door.close();
      await closeServer(oversized);
    }
  });

  it("logs a daemon that drops the connection after it started answering, but not a client that went away", async () => {
    const dropping = http.createServer((_request, response) => {
      response.writeHead(HTTP_STATUS.ok, { "content-type": "text/event-stream", "transfer-encoding": "chunked" });
      response.write("event: ping\n\n");
      setTimeout(() => {
        response.destroy();
      }, SETTLE_MS);
    });
    await listenOnHeadroomSocket(dropping);
    const logged: string[] = [];
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      log: (line) => {
        logged.push(line);
      },
    });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      await response.text().then(
        () => undefined,
        () => undefined,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
      const failures = logged.filter((line) => line.includes("ended mid-stream"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("POST /providers/codex/v1/messages");
    } finally {
      await door.close();
      await closeServer(dropping);
    }
  });

  /** A daemon that resets its first `resets` connections after reading the whole request and answers every later one, recording each request body it read. */
  async function resettingDaemon(resets: number): Promise<{ readonly bodies: readonly string[]; readonly close: () => Promise<void> }> {
    const bodies: string[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        bodies.push(body);
        if (bodies.length <= resets) {
          request.socket.destroy();
          return;
        }
        response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
        response.end(JSON.stringify({ answered: bodies.length }));
      });
    });
    await listenOnHeadroomSocket(server);
    return {
      bodies,
      close: async () => {
        await closeServer(server);
      },
    };
  }

  it("replays a hop the daemon reset before any response byte, so the client sees the answer and no error", async () => {
    const daemon = await resettingDaemon(1);
    const logged: string[] = [];
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      log: (line) => {
        logged.push(line);
      },
    });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(await response.json()).toEqual({ answered: 2 });
      expect(daemon.bodies).toEqual([MESSAGES_BODY, MESSAGES_BODY]);
      expect(logged.filter((line) => line.includes("replaying once"))).toHaveLength(1);
      expect(logged.filter((line) => line.includes("failed (POST"))).toHaveLength(0);
    } finally {
      await door.close();
      await daemon.close();
    }
  });

  it("answers 502 when the daemon resets the replay too, having sent it exactly twice", async () => {
    const daemon = await resettingDaemon(Number.POSITIVE_INFINITY);
    const logged: string[] = [];
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      log: (line) => {
        logged.push(line);
      },
    });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      // A connection the daemon keeps resetting is a daemon that is not serving, which the 502 still says plainly.
      expect(JSON.stringify(await response.json())).toContain("the headroom daemon is unreachable");
      expect(daemon.bodies).toHaveLength(2);
      expect(logged.filter((line) => line.includes("failed (POST") && line.includes("replay, client still waiting"))).toHaveLength(1);
    } finally {
      await door.close();
      await daemon.close();
    }
  });

  it("serves a headroom-ineligible or flag-less session directly, never through the hop", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
    try {
      // No headroom flag header: the session never asked for the hop, so the door serves the route itself.
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.ok);
      await settle();
      expect(headroom.seen()).toHaveLength(0);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it(
    "sends a native session's helper through the hop to the provider its main loop is on, under the provider's tier mapping",
    async () => {
      const upstream = await fakeProviderUpstream();
      const headroom = await fakeHeadroom();
      const door = await startDoor({ files: { [`${PROVIDERS_DIR}/z.json`]: { ...httpProvider(upstream.port), env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" } } } });
      try {
        // A launch with no provider: the capability, the session id and the headroom flag, and no provider header.
        const send = async (model: string, requestClass: string): Promise<number> =>
          (await fetch(`${door.url}/v1/messages`, { dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, [SESSION_HEADER]: "session-native", "x-claude-code-request-class": requestClass }, body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) })).status;
        expect(await send("z/glm-5.3", "main")).toBe(HTTP_STATUS.ok);
        expect(await send("claude-haiku-5-5", "auxiliary")).toBe(HTTP_STATUS.ok);
        expect(headroom.seen()).toHaveLength(2);
        expect(upstream.seen().map((seen) => seen.body).map((body): unknown => (JSON.parse(body) as { readonly model?: unknown }).model)).toEqual(["glm-5.3", "glm-4.5-air"]);
      } finally {
        await door.close();
        await headroom.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "keeps the door-attached provider credential away from headroom: headroom sees only placeholders of what the client presented and a hop id, and the provider's upstream receives the provider file's own credential, never the client's",
    async () => {
      const upstream = await fakeProviderUpstream();
      const headroom = await fakeHeadroom();
      const door = await startDoor({ files: { [`${PROVIDERS_DIR}/z.json`]: httpProvider(upstream.port) } });
      try {
        const base = { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN };
        const bearer = await fetch(`${door.url}/providers/z/v1/messages`, { dispatcher: trusting, method: "POST", headers: { ...base, authorization: `Bearer ${CLIENT_PRESENTED_BEARER}` }, body: MESSAGES_BODY });
        expect(bearer.status).toBe(HTTP_STATUS.ok);
        const apiKey = await fetch(`${door.url}/providers/z/v1/messages`, { dispatcher: trusting, method: "POST", headers: { ...base, "x-api-key": CLIENT_PRESENTED_KEY }, body: MESSAGES_BODY });
        expect(apiKey.status).toBe(HTTP_STATUS.ok);

        const [bearerHop, apiKeyHop] = headroom.seen();
        expect(bearerHop?.headers.authorization).toBe(`Bearer ${SEQUESTERED_CREDENTIAL}`);
        expect(apiKeyHop?.headers["x-api-key"]).toBe(SEQUESTERED_CREDENTIAL);
        for (const seen of headroom.seen()) {
          expect(JSON.stringify(seen.headers)).not.toContain(PROVIDER_TOKEN);
          expect(seen.headers[HOP_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
        }
        expect(bearerHop?.headers[HOP_ID_HEADER]).not.toBe(apiKeyHop?.headers[HOP_ID_HEADER]);

        const [bearerUpstream, apiKeyUpstream] = upstream.seen();
        expect(bearerUpstream?.headers.authorization).toBe(`Bearer ${PROVIDER_TOKEN}`);
        expect(apiKeyUpstream?.headers.authorization).toBe(`Bearer ${PROVIDER_TOKEN}`);
        expect(bearerUpstream?.url).toBe("/v1/messages");
        // Neither the client's own presentations nor anything of the door's machinery reaches the provider.
        for (const seen of upstream.seen()) {
          expect(seen.headers["x-api-key"]).toBeUndefined();
          expect(JSON.stringify(seen.headers)).not.toContain(CLIENT_PRESENTED_BEARER);
          expect(JSON.stringify(seen.headers)).not.toContain(CLIENT_PRESENTED_KEY);
          expect(seen.headers[HOP_ID_HEADER]).toBeUndefined();
          expect(seen.headers[HOP_SECRET_HEADER]).toBeUndefined();
          expect(JSON.stringify(seen.headers)).not.toContain(SEQUESTERED_CREDENTIAL);
        }
      } finally {
        await door.close();
        await headroom.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "admits on the direct listener only a live hop id for its own provider with this generation's secret, and never a reused one",
    async () => {
      const upstream = await fakeProviderUpstream();
      let releaseHop: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        releaseHop = resolve;
      });
      const headroom = await fakeHeadroom({ hold: async () => { await held; } });
      const door = await startDoor({ files: { [`${PROVIDERS_DIR}/z.json`]: httpProvider(upstream.port), [`${PROVIDERS_DIR}/other.json`]: httpProvider(upstream.port) } });
      const direct = async (requestPath: string, headers: Readonly<Record<string, string>>): Promise<number> =>
        (await fetch(`http://127.0.0.1:${String(door.directPort())}${requestPath}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: MESSAGES_BODY })).status;
      try {
        const client = fetch(`${door.url}/providers/z/v1/messages`, {
          dispatcher: trusting,
          method: "POST",
          headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, authorization: `Bearer ${PROVIDER_TOKEN}` },
          body: MESSAGES_BODY,
        });
        while (headroom.seen().length === 0) {
          await settle();
        }
        const hopId = String(headroom.seen()[0]?.headers[HOP_ID_HEADER]);

        // While the hop is live: an unknown id, the wrong secret, and the right id for another provider all fail before any route runs.
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET, [HOP_ID_HEADER]: randomUUID() })).toBe(HTTP_STATUS.unauthorized);
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: "not-this-generation", [HOP_ID_HEADER]: hopId })).toBe(HTTP_STATUS.unauthorized);
        expect(await direct("/providers/other/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET, [HOP_ID_HEADER]: hopId })).toBe(HTTP_STATUS.unauthorized);
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET })).toBe(HTTP_STATUS.unauthorized);
        expect(upstream.seen()).toHaveLength(0);

        releaseHop();
        expect((await client).status).toBe(HTTP_STATUS.ok);
        expect(upstream.seen()).toHaveLength(1);

        // The hop has ended: its id redeems nothing any more, even with the right secret and provider.
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET, [HOP_ID_HEADER]: hopId })).toBe(HTTP_STATUS.unauthorized);
        expect(upstream.seen()).toHaveLength(1);
      } finally {
        releaseHop();
        await door.close();
        await headroom.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "leaves an OAuth session's bearer untouched on the hop, since headroom forwards it straight to Claude Code's API and never back to the door",
    async () => {
      const headroom = await fakeHeadroom();
      const door = await startDoor({ files: {} });
      try {
        const response = await fetch(`${door.url}/v1/messages`, {
          dispatcher: trusting,
          method: "POST",
          headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, authorization: "Bearer made-up-oauth-token" },
          body: MESSAGES_BODY,
        });
        expect(response.status).toBe(HTTP_STATUS.ok);
        expect(headroom.seen()[0]?.headers.authorization).toBe("Bearer made-up-oauth-token");
        expect(headroom.seen()[0]?.headers[HOP_ID_HEADER]).toBeUndefined();
      } finally {
        await door.close();
        await headroom.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "carries a streamed response over the socket chunk by chunk, each event reaching the client before headroom sends the next",
    async () => {
      let releaseRest: () => void = () => undefined;
      const rest = new Promise<void>((resolve) => {
        releaseRest = resolve;
      });
      let received = "";
      const streaming = http.createServer((request, response) => {
        request.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
        });
        request.on("end", () => {
          response.writeHead(HTTP_STATUS.ok, { "content-type": "text/event-stream" });
          response.write(STREAM_EVENTS[0]);
          void rest.then(() => {
            response.end(STREAM_EVENTS[1]);
          });
        });
      });
      await listenOnHeadroomSocket(streaming);
      const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
      try {
        const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
          dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
        expect(response.status).toBe(HTTP_STATUS.ok);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        const body = response.body;
        if (body === null) {
          throw new Error("expected a streamed body");
        }
        const reader = body.pipeThrough(new TextDecoderStream()).getReader();
        const first = await reader.read();
        // Headroom has not sent the second event yet: what arrived is exactly the first, relayed as it was written.
        expect(first.value).toBe(STREAM_EVENTS[0]);
        releaseRest();
        let remainder = "";
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          remainder += chunk.value;
        }
        expect(remainder).toBe(STREAM_EVENTS[1]);
        expect(JSON.parse(received)).toEqual(JSON.parse(MESSAGES_BODY));
      } finally {
        releaseRest();
        await door.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "never dials a process squatting on headroom's old TCP port, whether the daemon is down or serving on its socket",
    async () => {
      // The squatter holds a loopback port and counts every connection it is offered. The earlier release's state file names that port, as it would after the daemon it described died and the port was taken.
      let squatterConnections = 0;
      const squatter = net.createServer((socket) => {
        squatterConnections += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) => {
        squatter.listen(0, "127.0.0.1", resolve);
      });
      const squatterAddress = squatter.address();
      if (squatterAddress === null || typeof squatterAddress === "string") {
        throw new Error("squatter has no TCP address");
      }
      fs.writeFileSync(path.join(home.paths.headroomDir, "state.json"), JSON.stringify({ supervisorPid: SUPERVISOR_PID, headroomPid: SUPERVISOR_PID + 1, port: squatterAddress.port, lastPort: squatterAddress.port }));
      const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider } });
      const send = async (): Promise<Awaited<ReturnType<typeof fetch>>> =>
        await fetch(`${door.url}/providers/codex/v1/messages`, {
          dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      try {
        // The daemon is down: nothing names a socket, so the hop answers 502 and the port in the old state is never tried.
        expect((await send()).status).toBe(HTTP_STATUS.badGateway);
        // The current state file rewritten in the old shape, with a port in it, is not a socket to dial either.
        fs.writeFileSync(home.paths.headroomStateFile, JSON.stringify({ supervisorPid: SUPERVISOR_PID, headroomPid: SUPERVISOR_PID + 1, port: squatterAddress.port }));
        expect((await send()).status).toBe(HTTP_STATUS.badGateway);
        // The daemon comes up on its socket: the request reaches it there, and still nothing reaches the squatter.
        const headroom = await fakeHeadroom();
        const served = await send();
        expect(served.status).toBe(HTTP_STATUS.ok);
        expect(headroom.seen()).toHaveLength(1);
        await settle();
        expect(squatterConnections).toBe(0);
      } finally {
        await door.close();
        await new Promise<void>((resolve) => {
          squatter.close(() => {
            resolve(undefined);
          });
        });
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it.each([
    [
      "a socket directory other users can enter",
      (): void => {
        fs.chmodSync(home.paths.headroomSocketDir, WORLD_DIR_MODE);
      },
      (): string => `the headroom socket directory ${home.paths.headroomSocketDir} has mode 0755, which lets other users reach it; it must be accessible to its owner only`,
    ],
    [
      "a socket directory that is a symlink",
      (): void => {
        const real = `${home.paths.headroomSocketDir}.real`;
        fs.renameSync(home.paths.headroomSocketDir, real);
        fs.symlinkSync(real, home.paths.headroomSocketDir);
      },
      (): string => `the headroom socket directory ${home.paths.headroomSocketDir} is a symlink; it must be the real directory`,
    ],
    [
      "a socket that is a symlink",
      (): void => {
        const real = path.join(home.paths.headroomSocketDir, "real.sock");
        fs.renameSync(home.socketPath, real);
        fs.symlinkSync(real, home.socketPath);
      },
      (): string => `the headroom socket ${home.socketPath} is a symlink; it must be the real socket`,
    ],
  ])(
    "refuses %s, failing the request with the reason and sending headroom nothing",
    async (_name, tamper, reason) => {
      const headroom = await fakeHeadroom();
      tamper();
      const logged: string[] = [];
      const door = await startDoor({
        files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
        log: (line) => {
          logged.push(line);
        },
      });
      try {
        const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
          dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
        expect(response.status).toBe(HTTP_STATUS.badGateway);
        expect(await response.json()).toEqual({ type: "error", error: { type: "api_error", message: `agent-shim front door: refusing to send this request to headroom: ${reason()}` } });
        expect(logged).toContain(`front door: refusing the headroom hop (POST /providers/codex/v1/messages): ${reason()}`);
        await settle();
        expect(headroom.seen()).toHaveLength(0);
      } finally {
        await door.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it("creates its socket directory owner-only in these tests, exactly as the supervisor does", () => {
    expect(fs.lstatSync(home.paths.headroomSocketDir).mode & WORLD_DIR_MODE).toBe(HEADROOM_SOCKET_DIR_MODE & WORLD_DIR_MODE);
  });
});
