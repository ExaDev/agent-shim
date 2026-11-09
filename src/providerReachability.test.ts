import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECT_SYN_RETRANSMISSIONS_TOLERATED,
  DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  TCP_INITIAL_RETRANSMISSION_TIMEOUT_MS,
  couldNotConnectMessage,
  dialTargetOf,
  probeProviderReachabilities,
  probeProviderReachability,
  providerConnectTimeoutMs,
  realBaseUrlBatchProbe,
  realBaseUrlProbe,
} from "./providerReachability";
import { displayBaseUrl } from "./baseUrlDisplay";
import type { ProbeWorkers } from "./frontdoor/probe";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
      });
    }),
  );
});

/** The TCP port a listening server is bound to. */
function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return (address satisfies AddressInfo).port;
}

/** A loopback listener's port, kept listening until the test ends. */
async function listeningPort(): Promise<number> {
  const server = http.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return portOf(server);
}

/** A loopback port nothing listens on: bound and released, so a connect to it is refused at once. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = portOf(server);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve(undefined);
    });
  });
  return port;
}

/** A provider's own connect timeout, distinct from the default so a probe given the default would be caught. */
const OWN_CONNECT_TIMEOUT_MS = 1_500;

/** A probe bound short enough that a test waiting it out stays quick. */
const SHORT_CONNECT_BOUND_MS = 200;

describe("the provider connect timeout", () => {
  it("defaults to the original SYN and each tolerated retransmission, each waiting the backed-off timeout", () => {
    let total = 0;
    for (let attempt = 0; attempt <= CONNECT_SYN_RETRANSMISSIONS_TOLERATED; attempt += 1) {
      total += TCP_INITIAL_RETRANSMISSION_TIMEOUT_MS * 2 ** attempt;
    }
    expect(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS).toBe(total);
  });

  it("is the provider's own setting when it has one", () => {
    expect(providerConnectTimeoutMs({ connectTimeoutMs: OWN_CONNECT_TIMEOUT_MS })).toBe(OWN_CONNECT_TIMEOUT_MS);
    expect(providerConnectTimeoutMs({})).toBe(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS);
  });
});

describe("dialTargetOf", () => {
  it("takes the scheme's port when the URL names none, and strips an IPv6 literal's brackets", () => {
    expect(dialTargetOf("https://api.z.ai/api/anthropic")).toEqual({ host: "api.z.ai", port: 443 });
    expect(dialTargetOf("http://example.com")).toEqual({ host: "example.com", port: 80 });
    expect(dialTargetOf("http://[::1]:8000")).toEqual({ host: "::1", port: 8000 });
  });

  it("has no target for a scheme nothing dials", () => {
    expect(dialTargetOf("ftp://example.com")).toBeUndefined();
  });
});

describe("probeProviderReachability", () => {
  it("probes the base URL with the provider's own bound, and names the provider, URL and reason when it fails", () => {
    const asked: [string, number][] = [];
    const result = probeProviderReachability("spark", { baseUrl: "http://192.0.2.1:8000", connectTimeoutMs: OWN_CONNECT_TIMEOUT_MS }, (baseUrl, timeoutMs) => {
      asked.push([baseUrl, timeoutMs]);
      return { ok: false, reason: "no connection accepted within 1500ms" };
    });
    expect(asked).toEqual([["http://192.0.2.1:8000", OWN_CONNECT_TIMEOUT_MS]]);
    expect(result).toEqual({ ok: false, message: couldNotConnectMessage("provider spark", "http://192.0.2.1:8000", "no connection accepted within 1500ms") });
    expect(couldNotConnectMessage("provider spark", "http://192.0.2.1:8000", "x")).toBe("provider spark could not connect to http://192.0.2.1:8000: x");
  });
});

describe("realBaseUrlProbe", () => {
  it("passes a base URL whose host accepts the connection", async () => {
    expect(realBaseUrlProbe(`http://127.0.0.1:${String(await listeningPort())}`, DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS)).toEqual({ ok: true });
  });

  it("fails a base URL whose port refuses the connection, with the refusal as the reason", async () => {
    const verdict = realBaseUrlProbe(`http://127.0.0.1:${String(await closedPort())}`, DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS);
    if (verdict.ok) {
      throw new Error("expected the probe to fail");
    }
    expect(verdict.reason).toContain("ECONNREFUSED");
  });

  it("fails a base URL whose scheme nothing dials", () => {
    expect(realBaseUrlProbe("ftp://example.com", SHORT_CONNECT_BOUND_MS)).toEqual({ ok: false, reason: "the base URL is neither http nor https" });
  });

  it("answers a batch in the order it was given, whichever targets are dialled and whichever are not", async () => {
    const open = `http://127.0.0.1:${String(await listeningPort())}`;
    const closed = `http://127.0.0.1:${String(await closedPort())}`;
    const verdicts = realBaseUrlBatchProbe([
      { baseUrl: closed, timeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS },
      { baseUrl: "ftp://example.com", timeoutMs: SHORT_CONNECT_BOUND_MS },
      { baseUrl: open, timeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS },
    ]);
    const [refused, undialled, accepted, ...rest] = verdicts;
    if (refused === undefined || refused.ok) {
      throw new Error("expected the refused port to fail the probe");
    }
    expect(refused.reason).toContain("ECONNREFUSED");
    expect(undialled).toEqual({ ok: false, reason: "the base URL is neither http nor https" });
    expect(accepted).toEqual({ ok: true });
    expect(rest).toEqual([]);
  });

  it("gives a reason for a closed localhost port, for the probe and for the line doctor and the door report, never an empty one", async () => {
    const port = await closedPort();
    const [verdict] = realBaseUrlBatchProbe([{ baseUrl: `http://localhost:${String(port)}`, timeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS }]);
    if (verdict === undefined || verdict.ok) {
      throw new Error("expected the refused localhost port to fail the probe");
    }
    expect(verdict.reason).toMatch(/^ECONNREFUSED: .*ECONNREFUSED/u);
    expect(verdict.reason).not.toMatch(/:\s*$/u);
    const line = couldNotConnectMessage("provider local", `http://localhost:${String(port)}`, verdict.reason);
    expect(line).toBe(`provider local could not connect to http://localhost:${String(port)}: ${verdict.reason}`);
  });

  it("never lets a report end on a bare colon, whatever reason it is given", () => {
    expect(couldNotConnectMessage("provider p", "http://h.example", "")).toBe("provider p could not connect to http://h.example: the connection failed with no reason given");
    expect(couldNotConnectMessage("provider p", "http://h.example", "  ")).toMatch(/: the connection failed with no reason given$/u);
  });

  it("answers a base URL that names port 0 with a reason, as a verdict, without starting a probe for it", () => {
    const started: unknown[] = [];
    const workers: ProbeWorkers = { start: (_source, data) => { started.push(data.port); return { verdict: () => ({ ok: true }) }; } };
    expect(realBaseUrlBatchProbe([{ baseUrl: "http://h.example:0/", timeoutMs: SHORT_CONNECT_BOUND_MS }], workers)).toEqual([{ ok: false, reason: "the base URL names port 0, which nothing listens on" }]);
    expect(started).toEqual([]);
  });

  it("pairs each verdict with its own base URL when targets that are not dialled sit between and around dialled ones", () => {
    // Each probed target's verdict names its port, so a verdict handed to the wrong place shows.
    const workers: ProbeWorkers = { start: (_source, data) => ({ verdict: () => ({ ok: false, reason: `probed ${String(data.port)}` }) }) };
    const verdicts = realBaseUrlBatchProbe(
      [
        { baseUrl: "http://h.example:0/", timeoutMs: SHORT_CONNECT_BOUND_MS },
        { baseUrl: "http://192.0.2.1:11", timeoutMs: SHORT_CONNECT_BOUND_MS },
        { baseUrl: "ftp://example.com", timeoutMs: SHORT_CONNECT_BOUND_MS },
        { baseUrl: "http://192.0.2.1:12", timeoutMs: SHORT_CONNECT_BOUND_MS },
        { baseUrl: "http://h.example:0/", timeoutMs: SHORT_CONNECT_BOUND_MS },
        { baseUrl: "ftp://example.org", timeoutMs: SHORT_CONNECT_BOUND_MS },
      ],
      workers,
    );
    expect(verdicts.map((verdict) => (verdict.ok ? "ok" : verdict.reason))).toEqual([
      "the base URL names port 0, which nothing listens on",
      "probed 11",
      "the base URL is neither http nor https",
      "probed 12",
      "the base URL names port 0, which nothing listens on",
      "the base URL is neither http nor https",
    ]);
  });

  it("starts the probe of every target before it waits on any, whichever targets are dialled", () => {
    const events: string[] = [];
    const workers: ProbeWorkers = {
      start: (_source, data) => {
        const port = String(data.port);
        events.push(`start ${port}`);
        return {
          verdict: () => {
            events.push(`wait ${port}`);
            return { ok: true };
          },
        };
      },
    };
    const verdicts = realBaseUrlBatchProbe(
      [
        { baseUrl: "http://192.0.2.1:1", timeoutMs: SHORT_CONNECT_BOUND_MS },
        { baseUrl: "ftp://example.com", timeoutMs: SHORT_CONNECT_BOUND_MS },
        { baseUrl: "http://192.0.2.1:3", timeoutMs: SHORT_CONNECT_BOUND_MS },
      ],
      workers,
    );
    expect(events).toEqual(["start 1", "start 3", "wait 1", "wait 3"]);
    expect(verdicts).toEqual([{ ok: true }, { ok: false, reason: "the base URL is neither http nor https" }, { ok: true }]);
  });
});

describe("a base URL in what the probe and the door report", () => {
  const SECRET_BASE_URL = "https://user:hunter2@provider.example:8443/api/anthropic?key=abc123#frag";

  it("leaves out the userinfo, query and fragment, keeping the scheme, host, port and path", () => {
    expect(displayBaseUrl(SECRET_BASE_URL)).toBe("https://provider.example:8443/api/anthropic");
    expect(displayBaseUrl("http://127.0.0.1:18080")).toBe("http://127.0.0.1:18080");
  });

  it("is what the could-not-connect line names", () => {
    const line = couldNotConnectMessage("provider z", SECRET_BASE_URL, "ECONNREFUSED");
    expect(line).toBe("provider z could not connect to https://provider.example:8443/api/anthropic: ECONNREFUSED");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("abc123");
  });
});

describe("probeProviderReachabilities", () => {
  const HTTP = { displayName: "Http", credential: { sources: [{ literal: "placeholder" }] } };

  it("probes only the http providers, each within its own bound, and reports each failure under its provider's name", () => {
    const asked: (readonly { readonly baseUrl: string; readonly timeoutMs: number }[])[] = [];
    const lines = probeProviderReachabilities(
      [
        { name: "first", provider: { ...HTTP, baseUrl: "http://192.0.2.1:1", connectTimeoutMs: OWN_CONNECT_TIMEOUT_MS } },
        { name: "codex", provider: { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } } },
        { name: "second", provider: { ...HTTP, baseUrl: "http://192.0.2.1:2" } },
        { name: "third", provider: { ...HTTP, baseUrl: "http://192.0.2.1:3" } },
      ],
      (targets) => {
        asked.push(targets);
        return [{ ok: true }, { ok: false, reason: "refused" }, { ok: true }];
      },
    );
    expect(asked).toEqual([
      [
        { baseUrl: "http://192.0.2.1:1", timeoutMs: OWN_CONNECT_TIMEOUT_MS },
        { baseUrl: "http://192.0.2.1:2", timeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS },
        { baseUrl: "http://192.0.2.1:3", timeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS },
      ],
    ]);
    expect([...lines]).toEqual([["second", couldNotConnectMessage("provider second", "http://192.0.2.1:2", "refused")]]);
  });

  it("fails loudly when the probe answers fewer verdicts than it was given targets", () => {
    expect(() => probeProviderReachabilities([{ name: "first", provider: { ...HTTP, baseUrl: "http://192.0.2.1:1" } }], () => [])).toThrow("fewer verdicts");
  });
});
