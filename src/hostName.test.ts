import { describe, expect, it } from "vitest";

import { parseDialAuthority } from "./baseUrlDial";
import { proxyBypassSyntaxProblem } from "./config/proxyBypass";
import { dnsNameProblem, isDottedDecimalIpv4 } from "./hostName";

const PORT = 443;

/** Hosts, each with whether the one shared grammar takes it, as an unbracketed name or address. */
const TABLE: readonly (readonly [string, boolean])[] = [
  ["example.com", true],
  ["Example.COM", true],
  ["mcp.example.com", true],
  ["localhost", true],
  ["a", true],
  ["a-b.example.com", true],
  ["xn--bcher-kva.example", true],
  ["my_service", true],
  ["_dmarc.example.com", true],
  ["a_b.c", true],
  ["my_bucket.s3.amazonaws.com", true],
  ["1host", true],
  ["host1", true],
  ["10.0.0.1", true],
  ["255.255.255.255", true],
  ["0.0.0.0", true],
  ["", false],
  ["-bad.example.com", false],
  ["bad-.example.com", false],
  ["bad..example.com", false],
  ["exa mple.com", false],
  ["exa%20mple.com", false],
  ["exa*mple.com", false],
  ["exa,mple.com", false],
  ["300.1.1.1", false],
  ["1.2.3", false],
  ["1.2.3.4.5", false],
  ["127.1", false],
  ["0x7f.1", false],
  ["a.0X1F", false],
  ["a.0Xff", false],
  ["0X7F.1", false],
  ["010.0.0.1", false],
  ["2130706433", false],
  ["a\u0000b", false],
];

describe("one name grammar for every place that takes a host", () => {
  it.each(TABLE)("takes %j exactly as the table says, as a CONNECT host and as a NO_PROXY entry", (host, accepted) => {
    expect("refusal" in parseDialAuthority(`${host}:${String(PORT)}`, PORT), `CONNECT ${host}`).toBe(!accepted);
    expect(proxyBypassSyntaxProblem(host) === undefined, `NO_PROXY ${host}`).toBe(accepted);
  });

  it("is the grammar the two callers call, so a change to it moves both", () => {
    for (const [host, accepted] of TABLE) {
      if (host !== "") {
        expect(isDottedDecimalIpv4(host) || dnsNameProblem(host) === undefined, host).toBe(accepted);
      }
    }
  });

  it("leaves each caller its own differences around the name", () => {
    expect(proxyBypassSyntaxProblem(".example.com")).toBeUndefined();
    expect(proxyBypassSyntaxProblem("*.example.com")).toBeDefined();
    expect(parseDialAuthority("example.com.:443", PORT)).toEqual({ host: "example.com", port: PORT });
    expect(proxyBypassSyntaxProblem("example.com.")).toBeDefined();
  });
});
