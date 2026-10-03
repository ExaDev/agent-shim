import { X509Certificate, createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CONNECT_INTERCEPT_HOST,
  createLeafCache,
  ensureCa,
  HTTPS_PORT,
  forwardableHeaders,
  generateCa,
  isInterceptedHost,
  mintLeaf,
  parseConnectTarget,
  servedByPipeline,
  CONNECT_INTERCEPT_HOSTS,
  ROUTED_PATH_PREFIX,
  type CaMaterial,
  type ConnectCertStore,
} from "./connect";

describe("CONNECT routing decisions", () => {
  it("parses an authority into a lowercased host and numeric port, defaulting to 443", () => {
    expect(parseConnectTarget("api.anthropic.com:443")).toEqual({ host: "api.anthropic.com", port: 443 });
    expect(parseConnectTarget("Statsig.Anthropic.COM")).toEqual({ host: "statsig.anthropic.com", port: HTTPS_PORT });
    expect(parseConnectTarget("api.anthropic.com:8443")).toEqual({ host: "api.anthropic.com", port: 8443 });
  });

  it("rejects an authority that names no host or an unusable port", () => {
    expect(parseConnectTarget("")).toBeUndefined();
    expect(parseConnectTarget(":443")).toBeUndefined();
    expect(parseConnectTarget("host:not-a-port")).toBeUndefined();
    expect(parseConnectTarget("host:0")).toBeUndefined();
    expect(parseConnectTarget("host:70000")).toBeUndefined();
  });

  it("intercepts exactly the configured hosts, nothing more", () => {
    expect(isInterceptedHost("api.anthropic.com", CONNECT_INTERCEPT_HOSTS)).toBe(true);
    expect(isInterceptedHost("platform.claude.com", CONNECT_INTERCEPT_HOSTS)).toBe(true);
    expect(isInterceptedHost("statsig.anthropic.com", CONNECT_INTERCEPT_HOSTS)).toBe(false);
    expect(isInterceptedHost("api.anthropic.com.evil.example", CONNECT_INTERCEPT_HOSTS)).toBe(false);
  });

  it("routes exactly the paths under /v1/ to the routed handler, query strings included", () => {
    expect(servedByPipeline("/v1/messages")).toBe(true);
    expect(servedByPipeline("/v1/messages?beta=true")).toBe(true);
    expect(servedByPipeline("/v1/messages/count_tokens")).toBe(true);
    expect(servedByPipeline("/v1")).toBe(false);
    expect(servedByPipeline("/api/oauth/token")).toBe(false);
    expect(servedByPipeline(undefined)).toBe(false);
    expect(ROUTED_PATH_PREFIX).toBe("/v1/");
  });

  it("strips hop-by-hop headers and any header the Connection header names, without mutating the input", () => {
    const headers = {
      host: "api.anthropic.com",
      authorization: "Bearer tok",
      connection: "keep-alive, x-drop-me",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "x-drop-me": "gone",
      "x-keep-me": "here",
    };
    const forwarded = forwardableHeaders(headers);
    expect(forwarded).toEqual({ host: "api.anthropic.com", authorization: "Bearer tok", "x-keep-me": "here" });
    expect(headers["x-drop-me"]).toBe("gone");
  });
});

describe("certificate authority", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const ONE_DAY_MS = 86_400_000;
  /** The CA/Browser Forum ceiling on a publicly trusted leaf's lifetime, which Apple platforms also enforce. */
  const MAX_LEAF_LIFETIME_DAYS = 398;

  it("generates a CA whose subject is stable, and signs leaves issued by that CA with the host in their SAN", () => {
    const ca = generateCa(now);
    const again = generateCa(now);
    const caCert = new X509Certificate(ca.certPem);
    expect(caCert.subject).toBe("CN=agent-shim front door CA");
    expect(new X509Certificate(again.certPem).subject).toBe("CN=agent-shim front door CA");
    expect(caCert.ca).toBe(true);
    expect(caCert.verify(caCert.publicKey)).toBe(true);

    const leaf = mintLeaf(ca, [CONNECT_INTERCEPT_HOST], now);
    const cert = new X509Certificate(leaf.certPem);
    expect(cert.issuer).toBe("CN=agent-shim front door CA");
    expect(cert.ca).toBe(false);
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.checkIssued(caCert)).toBe(true);
    expect(cert.checkHost(CONNECT_INTERCEPT_HOST)).toBe(CONNECT_INTERCEPT_HOST);
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(cert.checkPrivateKey(createPrivateKey(leaf.keyPem))).toBe(true);
    expect(caCert.checkPrivateKey(createPrivateKey(ca.keyPem))).toBe(true);
  });

  it("puts an IP name in the SAN as an IP address and a hostname as a DNS name", () => {
    const leaf = new X509Certificate(mintLeaf(generateCa(now), ["127.0.0.1", "localhost", "::1"], now).certPem);
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leaf.checkIP("::1")).toBe("::1");
    expect(leaf.checkHost("localhost")).toBe("localhost");
    expect(leaf.checkHost("127.0.0.1")).toBeUndefined();
    expect(leaf.checkIP("127.0.0.2")).toBeUndefined();
  });

  it("dates a leaf to cover now and to stay inside the 398-day ceiling clients enforce on leaf lifetimes", () => {
    const leaf = new X509Certificate(mintLeaf(generateCa(now), ["a.example"], now).certPem);
    expect(new Date(leaf.validFrom).getTime()).toBeLessThan(now.getTime());
    expect(new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()).toBeLessThanOrEqual(MAX_LEAF_LIFETIME_DAYS * ONE_DAY_MS);
    expect(new Date(leaf.validTo).getTime()).toBeGreaterThan(now.getTime());
  });

  it("issues a leaf under a CA whose key is stored as PKCS#1, the form earlier releases persisted", () => {
    const ca = generateCa(now);
    const pkcs1 = createPrivateKey(ca.keyPem).export({ type: "pkcs1", format: "pem" });
    const leaf = new X509Certificate(mintLeaf({ certPem: ca.certPem, keyPem: pkcs1 }, ["a.example"], now).certPem);
    expect(leaf.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
  });

  it("mints each host's leaf once and reuses it", () => {
    const ca = generateCa(now);
    const leafFor = createLeafCache(ca, () => now);
    expect(leafFor("a.example")).toBe(leafFor("a.example"));
    expect(leafFor("a.example")).not.toBe(leafFor("b.example"));
  });

  it("keeps a stored CA that parses, and regenerates one that is missing or corrupt", () => {
    const good = generateCa(now);
    const writes: CaMaterial[] = [];
    let stored: CaMaterial | undefined;
    const store: ConnectCertStore = {
      loadCa: () => stored,
      writeCa: (ca) => {
        writes.push(ca);
        stored = ca;
      },
    };
    expect(ensureCa(store, () => good)).toBe(good);
    expect(writes).toHaveLength(1);
    // A stored CA is reused, not regenerated: every child's NODE_EXTRA_CA_CERTS points at it.
    expect(ensureCa(store, () => generateCa(now))).toBe(good);
    expect(writes).toHaveLength(1);
    stored = { certPem: "not a certificate", keyPem: good.keyPem };
    expect(ensureCa(store, () => good)).toBe(good);
    expect(writes).toHaveLength(2);
  });
});
