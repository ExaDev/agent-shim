import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { RC_WEB_FETCH_MAX_BYTES, RC_WEB_FETCH_MAX_REDIRECTS, fetchThroughWebProxy, isPrivateAddress, realRcWebFetch, rcWebFetchAllowsPrivateFromEnv, RC_WEB_FETCH_ALLOW_PRIVATE_ENV, type RcWebFetchDeps, type RcWebFetchHop } from "./rcWebFetch";

/**
 * The worker web-fetch proxy's bounds, each named by the fact it derives from: the scheme gate, the private-address refusal and its lift, the redirect walk and its bound, the byte cap, the deadline, the content-type gate and the non-2xx refusal. The dial and the resolver are fakes so every bound is driven deterministically; one final case runs the production dial itself against a loopback stand-in, so the real agent and resolver path is exercised too.
 */

/** A public address the fake resolver answers every name with. */
const PUBLIC_ADDRESS = "93.184.216.34";

/** A deadline wide enough that no fake dial trips it, for the cases that test other bounds. */
const WIDE_DEADLINE_MS = 5_000;

/** A deadline tight enough that a hanging dial trips it inside the test's patience. */
const TIGHT_DEADLINE_MS = 150;

/** The redirect statuses the walk follows (moved permanently, found), named because the shared enum stops at the statuses this door answers with. */
const HTTP_MOVED_PERMANENTLY = 301;
const HTTP_FOUND = 302;

/** Builds one hop whose body is a single chunk. */
function hopOf(status: number, options: Readonly<{ location?: string; contentType?: string; body?: string; chunks?: readonly string[] }> = {}): RcWebFetchHop {
  const body = options.chunks ?? (options.body === undefined ? [] : [options.body]);
  return {
    status,
    location: options.location,
    contentType: options.contentType,
    chunks: {
      [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => {
        let next = 0;
        return {
          next: async () =>
            next < body.length
              ? await Promise.resolve({ done: false as const, value: new TextEncoder().encode(body[next++] ?? "") })
              : await Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    },
  };
}

/** The deps every bounds case starts from: a dial scripted per URL path, a resolver answering the public address, the refusal stance and deadline under test. */
function depsOf(script: (url: URL, signal: AbortSignal) => Promise<RcWebFetchHop>, options: Readonly<{ allowPrivate?: boolean; deadlineMs?: number; lookup?: (hostname: string) => Promise<readonly string[]> }> = {}): RcWebFetchDeps {
  return {
    dial: script,
    lookup: options.lookup ?? (async () => await Promise.resolve([PUBLIC_ADDRESS])),
    allowPrivate: options.allowPrivate ?? false,
    deadlineMs: options.deadlineMs ?? WIDE_DEADLINE_MS,
  };
}

/** The deps and the dialled-URL record of a script keyed by pathname: every dial is recorded, and an unexpected pathname fails loudly. */
function scriptedDial(hops: Readonly<Record<string, RcWebFetchHop | ((signal: AbortSignal) => RcWebFetchHop)>>, options: Readonly<{ allowPrivate?: boolean; lookup?: (hostname: string) => Promise<readonly string[]> }> = {}): { readonly deps: RcWebFetchDeps; readonly dialled: string[] } {
  const dialled: string[] = [];
  return {
    dialled,
    deps: depsOf(async (url, signal) => {
      dialled.push(url.toString());
      const hop = hops[url.pathname];
      if (hop === undefined) {
        throw new Error(`unexpected dial of ${url.toString()}`);
      }
      return await (typeof hop === "function" ? hop(signal) : Promise.resolve(hop));
    }, options),
  };
}

describe("the private-address rule", () => {
  it("refuses exactly the address blocks that reach a machine's own interfaces or its private interior", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::6810:84e4")).toBe(false);
    // A URL's parser writes a v4-mapped literal in hex, so that spelling is judged as the address it carries too.
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:a00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:5db8:d822")).toBe(false);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("127.255.0.1")).toBe(true);
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.1.5")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd12:3456::1")).toBe(true);
    expect(isPrivateAddress("ff02::1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.5")).toBe(true);
    expect(isPrivateAddress("not-an-address")).toBe(true);
  });

  it("reads the lift from the environment with the mode variables' exact-value vocabulary", () => {
    expect(rcWebFetchAllowsPrivateFromEnv({})).toBe(false);
    expect(rcWebFetchAllowsPrivateFromEnv({ [RC_WEB_FETCH_ALLOW_PRIVATE_ENV]: "0" })).toBe(false);
    expect(rcWebFetchAllowsPrivateFromEnv({ [RC_WEB_FETCH_ALLOW_PRIVATE_ENV]: "1" })).toBe(true);
  });
});

describe("the worker web-fetch bounds", () => {
  it("follows a redirect and answers the final hop's facts with the requested url", async () => {
    const { deps, dialled } = scriptedDial({
      "/start": hopOf(HTTP_FOUND, { location: "/middle" }),
      "/middle": hopOf(HTTP_MOVED_PERMANENTLY, { location: "https://public.example/final" }),
      "/final": hopOf(HTTP_STATUS.ok, { contentType: "text/html; charset=utf-8", body: "<html>final</html>" }),
    });
    const outcome = await fetchThroughWebProxy("https://public.example/start", deps);
    expect(outcome).toEqual({ kind: "fetched", url: "https://public.example/start", destinationUrl: "https://public.example/final", contentType: "text/html; charset=utf-8", text: "<html>final</html>" });
    expect(dialled).toEqual(["https://public.example/start", "https://public.example/middle", "https://public.example/final"]);
  });

  it("refuses a scheme the proxy does not dial, without dialling at all", async () => {
    const { deps, dialled } = scriptedDial({});
    const outcome = await fetchThroughWebProxy("ftp://public.example/file", deps);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.errorType).toBe("web_fetch_scheme");
    }
    expect(dialled).toEqual([]);
  });

  it("refuses a bracketed IPv6 literal that is a private address as private, never as a name that did not resolve", async () => {
    for (const literal of ["[::1]", "[::ffff:127.0.0.1]"]) {
      // The resolver would fail for a name, so a literal sent to it (brackets left on, which net.isIP takes for a name) answers "did not resolve" and not "private".
      const scripted = scriptedDial({ "/probe": hopOf(HTTP_STATUS.ok, { contentType: "text/plain", body: "internal" }) }, { lookup: async () => await Promise.reject(new Error("ENOTFOUND")) });
      const refused = await fetchThroughWebProxy(`http://${literal}:8000/probe`, scripted.deps);
      expect(refused.kind, literal).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.errorType, literal).toBe("web_fetch_private_address");
      }
      expect(scripted.dialled, literal).toEqual([]);
    }
  });

  it("refuses a name that resolves to a private address, and dials it once the lift is set", async () => {
    const refusing = scriptedDial({ "/probe": hopOf(HTTP_STATUS.ok, { contentType: "text/plain", body: "internal" }) }, { lookup: async () => await Promise.resolve(["192.168.0.10"]) });
    const refused = await fetchThroughWebProxy("https://internal.example/probe", refusing.deps);
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.errorType).toBe("web_fetch_private_address");
      expect(refused.errorMessage).toContain("192.168.0.10");
    }
    expect(refusing.dialled).toEqual([]);

    const lifted = scriptedDial({ "/probe": hopOf(HTTP_STATUS.ok, { contentType: "text/plain", body: "internal" }) }, { allowPrivate: true, lookup: async () => await Promise.resolve(["192.168.0.10"]) });
    const fetched = await fetchThroughWebProxy("https://internal.example/probe", lifted.deps);
    expect(fetched).toEqual({ kind: "fetched", url: "https://internal.example/probe", destinationUrl: "https://internal.example/probe", contentType: "text/plain", text: "internal" });
    expect(lifted.dialled).toEqual(["https://internal.example/probe"]);
  });

  it("refuses a private literal target and a redirect that walks onto a private name", async () => {
    const literal = await fetchThroughWebProxy("http://127.0.0.1:47474/x", depsOf(async () => await Promise.resolve(hopOf(HTTP_STATUS.ok, { body: "loopback" }))));
    expect(literal.kind).toBe("refused");
    if (literal.kind === "refused") {
      expect(literal.errorType).toBe("web_fetch_private_address");
    }

    const { deps, dialled } = scriptedDial({ "/start": hopOf(HTTP_FOUND, { location: "http://10.0.0.5/inside" }) });
    const walked = await fetchThroughWebProxy("https://public.example/start", deps);
    expect(walked.kind).toBe("refused");
    if (walked.kind === "refused") {
      expect(walked.errorType).toBe("web_fetch_private_address");
    }
    expect(dialled).toEqual(["https://public.example/start"]);
  });

  it("refuses an unresolvable name and a malformed url", async () => {
    const unresolvable = await fetchThroughWebProxy("https://nx.example/", depsOf(async () => await Promise.resolve(hopOf(HTTP_STATUS.ok)), { lookup: async () => await Promise.reject(new Error("ENOTFOUND")) }));
    expect(unresolvable.kind).toBe("refused");
    if (unresolvable.kind === "refused") {
      expect(unresolvable.errorType).toBe("web_fetch_resolve");
    }
    const malformed = await fetchThroughWebProxy("not a url at all", depsOf(async () => await Promise.resolve(hopOf(HTTP_STATUS.ok))));
    expect(malformed.kind).toBe("refused");
    if (malformed.kind === "refused") {
      expect(malformed.errorType).toBe("web_fetch_malformed_url");
    }
  });

  it("refuses at the redirect bound, and settles a chain exactly at it", async () => {
    // A chain whose every hop redirects to the next pathname, /0 through /N: /N-1 answers the page.
    const chainOf = (length: number): Record<string, RcWebFetchHop> => {
      const hops: Record<string, RcWebFetchHop> = {};
      for (let step = 0; step < length; step += 1) {
        hops[`/${String(step)}`] = hopOf(HTTP_FOUND, { location: `/${String(step + 1)}` });
      }
      hops[`/${String(length)}`] = hopOf(HTTP_STATUS.ok, { contentType: "text/plain", body: "settled" });
      return hops;
    };
    const atBound = scriptedDial(chainOf(RC_WEB_FETCH_MAX_REDIRECTS));
    const settled = await fetchThroughWebProxy(`https://public.example/${String(0)}`, atBound.deps);
    expect(settled).toEqual({ kind: "fetched", url: "https://public.example/0", destinationUrl: `https://public.example/${String(RC_WEB_FETCH_MAX_REDIRECTS)}`, contentType: "text/plain", text: "settled" });

    const pastBound = scriptedDial(chainOf(RC_WEB_FETCH_MAX_REDIRECTS + 1));
    const refused = await fetchThroughWebProxy(`https://public.example/${String(0)}`, pastBound.deps);
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.errorType).toBe("web_fetch_too_many_redirects");
    }
  });

  it("refuses a body past the CLI reader's byte cap", async () => {
    const oversized = "a".repeat(RC_WEB_FETCH_MAX_BYTES + 1);
    const { deps } = scriptedDial({ "/big": hopOf(HTTP_STATUS.ok, { contentType: "text/plain", body: oversized }) });
    const outcome = await fetchThroughWebProxy("https://public.example/big", deps);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.errorType).toBe("web_fetch_too_large");
    }
  });

  it("refuses when the fetch does not settle within its deadline", async () => {
    const hangingDial = async (_url: URL, signal: AbortSignal): Promise<RcWebFetchHop> =>
      await new Promise<RcWebFetchHop>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("the dial was aborted"));
        }, { once: true });
      });
    const outcome = await fetchThroughWebProxy("https://public.example/slow", depsOf(hangingDial, { deadlineMs: TIGHT_DEADLINE_MS }));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.errorType).toBe("web_fetch_deadline");
    }
  });

  it("refuses a non-2xx final answer by naming the status", async () => {
    const { deps } = scriptedDial({ "/missing": hopOf(HTTP_STATUS.notFound, { contentType: "text/plain", body: "gone" }) });
    const outcome = await fetchThroughWebProxy("https://public.example/missing", deps);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.errorType).toBe("web_fetch_status");
      expect(outcome.errorMessage).toContain("404");
    }
  });

  it("carries the readable content types as text and refuses the binary ones", async () => {
    const json = scriptedDial({ "/data": hopOf(HTTP_STATUS.ok, { contentType: "application/json", body: "{\"ok\":true}" }) });
    const jsonAnswer = await fetchThroughWebProxy("https://public.example/data", json.deps);
    expect(jsonAnswer).toEqual({ kind: "fetched", url: "https://public.example/data", destinationUrl: "https://public.example/data", contentType: "application/json", text: "{\"ok\":true}" });

    const untyped = scriptedDial({ "/bare": hopOf(HTTP_STATUS.ok, { body: "no content type named" }) });
    const untypedAnswer = await fetchThroughWebProxy("https://public.example/bare", untyped.deps);
    expect(untypedAnswer).toEqual({ kind: "fetched", url: "https://public.example/bare", destinationUrl: "https://public.example/bare", contentType: undefined, text: "no content type named" });

    const image = scriptedDial({ "/pic": hopOf(HTTP_STATUS.ok, { contentType: "image/png", body: "\u0089PNG" }) });
    const imageAnswer = await fetchThroughWebProxy("https://public.example/pic", image.deps);
    expect(imageAnswer.kind).toBe("refused");
    if (imageAnswer.kind === "refused") {
      expect(imageAnswer.errorType).toBe("web_fetch_content_type");
    }
  });
});

describe("the production web-fetch dial", () => {
  const servers: http.Server[] = [];

  /** Binds `server` on `host` with an ephemeral port and resolves to the port, or rejects with the bind error: waiting on the success callback alone would never settle when the host cannot bind the address. */
  const bindOn = async (server: http.Server, host: string): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        resolve(undefined);
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the stand-in did not bind a TCP port");
    }
    return address.port;
  };

  /** The errors a host without an address (an IPv6 loopback it does not have, a documentation address nothing is assigned) answers a bind with: the address is not available, or its family is not supported. */
  const isAddressUnavailable = (error: unknown): boolean => error instanceof Error && "code" in error && (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT");

  /** Starts the loopback stand-in every case in this block fetches, with its redirect hop. */
  const startStandIn = async (host = "127.0.0.1"): Promise<number> => {
    const server = http.createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(HTTP_FOUND, { location: "/final" });
        response.end();
        return;
      }
      response.writeHead(HTTP_STATUS.ok, { "content-type": "text/plain" });
      response.end("stand-in final page");
    });
    servers.push(server);
    return await bindOn(server, host);
  };

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    }
  });

  it("rejects a bind to an address the host does not have, instead of never settling, and only for the errors that mean the address is unavailable", async () => {
    // 2001:db8::/32 is reserved for documentation, so no host has an address in it.
    await expect(startStandIn("2001:db8::99")).rejects.toSatisfy(isAddressUnavailable);
    // A name that is not an address is some other bind failure, which a skip must not hide.
    const failure = await startStandIn("not an address").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(isAddressUnavailable(failure)).toBe(false);
  });

  it("fetches a page at an IPv6 literal through the door's own agents, which dial the address and not the bracketed name", async (context) => {
    let port: number | undefined;
    try {
      port = await startStandIn("::1");
    } catch (error) {
      // A host with no IPv6 loopback cannot show this; the report lists the test as skipped there, not passed. Any other bind failure is a failure.
      if (!isAddressUnavailable(error)) {
        throw error;
      }
      context.skip();
    }
    if (port === undefined) {
      return;
    }
    const fetched = await realRcWebFetch({ allowPrivate: true })(`http://[::1]:${String(port)}/start`);
    expect(fetched.kind).toBe("fetched");
  });

  it("fetches through the door's own agents when the lift is set, and refuses the loopback without it", async () => {
    const port = await startStandIn();
    const lifted = realRcWebFetch({ allowPrivate: true });
    const fetched = await lifted(`http://127.0.0.1:${String(port)}/start`);
    expect(fetched).toEqual({ kind: "fetched", url: `http://127.0.0.1:${String(port)}/start`, destinationUrl: `http://127.0.0.1:${String(port)}/final`, contentType: "text/plain", text: "stand-in final page" });

    const refusing = realRcWebFetch({ allowPrivate: false });
    const refused = await refusing(`http://127.0.0.1:${String(port)}/final`);
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.errorType).toBe("web_fetch_private_address");
    }
  });
});
