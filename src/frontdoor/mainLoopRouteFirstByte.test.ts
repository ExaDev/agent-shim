import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { launchOf, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { followingMainLoop } from "./mainLoopRoute";
import type { RouteResolution } from "./pipeline";
import type { RoutedRequest } from "./route";

/** How long a rewrite is given to (wrongly) place a request before the rest of its head has arrived. */
const SETTLE_MS = 20;

const HEAD = '{"model":"claude-sonnet-5-5","messages":[';
const REST_SINGLE = '{"role":"user","content":"hi"}]}';
const REST_DOUBLED = '{"role":"user","content":"hi"}],"model":"other"}';

/** A request body the test feeds by hand, so it decides what the door has seen of it at any moment. */
function fedBody(): { readonly body: Readable; readonly push: (text: string) => void; readonly end: () => void } {
  const body = new Readable({ read: () => undefined });
  return {
    body,
    push: (text) => {
      body.push(Buffer.from(text));
    },
    end: () => {
      body.push(null);
    },
  };
}

/** The wrapper over a stand-in resolver that records when it is first asked, on a session whose main loop is on provider `z`, with `mapping` as the provider's answer to the model name. */
function world(mapping: "as-is" | "mapped"): { readonly follow: (body: Readable) => Promise<RouteResolution>; readonly asked: () => boolean } {
  let asked = false;
  const record = mainLoopRoutesOfLiveSessions();
  const launch = launchOf("first-byte");
  record.record(launch, { kind: "provider", provider: "z" });
  const resolve = async (request: RoutedRequest): Promise<RouteResolution> => {
    asked = true;
    return await Promise.resolve({ ok: true, route: { name: "stand-in", headroomEligible: false, headroomUpstream: undefined, serve: async () => { await Promise.resolve(); } }, request });
  };
  const wrapped = followingMainLoop(resolve, {
    record,
    providerMapping: () => ({ model: mapping === "as-is" ? { kind: "as-is" } : { kind: "mapped", model: "glm-5.3" }, credential: undefined }),
    loginOf: () => "login",
    definesProvider: () => false,
  });
  return {
    follow: async (body) => await wrapped({ method: "POST", url: "/v1/messages", headers: { "x-claude-code-request-class": "auxiliary" }, body, signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined, launch } }),
    asked: () => asked,
  };
}

describe("what a request waits for before it is placed", () => {
  it("is forwarded as it is as soon as its model is found, without waiting for the rest of the scan's head", async () => {
    const { follow, asked } = world("as-is");
    const fed = fedBody();
    fed.push(HEAD);
    const placing = follow(fed.body);
    await vi.waitFor(() => {
      expect(asked()).toBe(true);
    });
    fed.push(REST_SINGLE);
    fed.end();
    expect((await placing).ok).toBe(true);
  });

  it("waits, for a rewrite, until it has seen enough of the head to know the model is not named twice, and then still refuses a doubled field", async () => {
    const { follow, asked } = world("mapped");
    const fed = fedBody();
    fed.push(HEAD);
    const placing = follow(fed.body);
    // The rewrite cannot be told safe from the first bytes alone.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    expect(asked()).toBe(false);
    fed.push(REST_DOUBLED);
    fed.end();
    const resolution = await placing;
    expect(resolution).toMatchObject({ ok: false, status: HTTP_STATUS.badRequest });
    expect(asked()).toBe(false);
  });

  it("places a rewrite once the body has ended, however short it is", async () => {
    const { follow } = world("mapped");
    const fed = fedBody();
    fed.push(HEAD);
    const placing = follow(fed.body);
    fed.push(REST_SINGLE);
    fed.end();
    expect((await placing).ok).toBe(true);
  });
});
