import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECT_SYN_RETRANSMISSIONS_TOLERATED,
  DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  TCP_INITIAL_RETRANSMISSION_TIMEOUT_MS,
  couldNotConnectMessage,
  dialTargetOf,
  probeProviderReachability,
  providerConnectTimeoutMs,
  realBaseUrlProbe,
} from "./providerReachability";
import { displayBaseUrl } from "./baseUrlDisplay";

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
