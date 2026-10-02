import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ipBytes, issueCaCertificate, issueLeafCertificate } from "./x509";

const ONE_DAY_MS = 86_400_000;
/** A serial whose first hex digit is below 8 has its top bit clear, so it reads as a positive DER INTEGER. */
const POSITIVE_SERIAL = /^[0-7]/;

describe("ipBytes", () => {
  const hex = (address: string): string => ipBytes(address).toString("hex");

  it("encodes IPv4 as four octets", () => {
    expect(hex("127.0.0.1")).toBe("7f000001");
    expect(hex("192.168.10.255")).toBe("c0a80aff");
  });

  it("expands :: wherever it sits in an IPv6 address", () => {
    expect(hex("::1")).toBe("00000000000000000000000000000001");
    expect(hex("::")).toBe("00000000000000000000000000000000");
    expect(hex("fe80::1:2")).toBe("fe800000000000000000000000010002");
    expect(hex("2001:db8:0:0:0:0:0:1")).toBe("20010db8000000000000000000000001");
  });

  it("reads a trailing dotted IPv4 as its two groups", () => {
    expect(hex("::ffff:1.2.3.4")).toBe("00000000000000000000ffff01020304");
  });

  it("refuses text that is not an address", () => {
    expect(() => ipBytes("example.com")).toThrow("not an IP address");
  });
});

describe("issued certificates", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("encodes dates from 2050 on as GeneralizedTime and earlier ones as UTCTime", () => {
    const farFuture = new Date("2060-06-15T12:30:45Z");
    const ca = new X509Certificate(issueCaCertificate("test CA", now, farFuture).certPem);
    expect(new Date(ca.validFrom).toISOString()).toBe(now.toISOString());
    expect(new Date(ca.validTo).toISOString()).toBe(farFuture.toISOString());
  });

  it("gives every certificate a distinct positive serial", () => {
    const serials = new Set([issueCaCertificate("a", now, new Date(now.getTime() + ONE_DAY_MS)), issueCaCertificate("a", now, new Date(now.getTime() + ONE_DAY_MS))].map((ca) => new X509Certificate(ca.certPem).serialNumber));
    expect(serials.size).toBe(2);
    for (const serial of serials) {
      expect(serial).toMatch(POSITIVE_SERIAL);
    }
  });

  it("refuses a leaf with no names", () => {
    const ca = issueCaCertificate("test CA", now, new Date(now.getTime() + ONE_DAY_MS));
    expect(() => issueLeafCertificate(ca, [], now, new Date(now.getTime() + ONE_DAY_MS))).toThrow("at least one name");
  });

  it("does not let a leaf pass for a different CA's issue", () => {
    const end = new Date(now.getTime() + ONE_DAY_MS);
    const ca = issueCaCertificate("one", now, end);
    const other = issueCaCertificate("two", now, end);
    const leaf = new X509Certificate(issueLeafCertificate(ca, ["a.example"], now, end).certPem);
    expect(leaf.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
    expect(leaf.verify(new X509Certificate(other.certPem).publicKey)).toBe(false);
    expect(leaf.checkIssued(new X509Certificate(other.certPem))).toBe(false);
  });
});
