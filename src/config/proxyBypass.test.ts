import { describe, expect, it } from "vitest";

import { ConfigProfileSchema } from "./schema";
import { proxyBypassName, proxyBypassSyntaxProblem } from "./proxyBypass";

describe("proxyBypassSyntaxProblem", () => {
  it("accepts a host name, a leading-dot domain and an IPv4 address", () => {
    for (const entry of ["example.com", "mcp.example.com", ".example.com", "localhost", "10.0.0.1", "a-b.example.com", "MCP.Example.com"]) {
      expect(proxyBypassSyntaxProblem(entry), entry).toBeUndefined();
    }
  });

  it("refuses the forms the runtime would ignore or that are not a host, so a malformed entry cannot silently do nothing", () => {
    for (const entry of ["", " example.com", "example.com ", "*", "*.example.com", "https://example.com", "example.com/path", "user@example.com", "a.example.com,b.example.com", "exa mple.com", "-bad.example.com", "bad-.example.com", "bad..example.com", "example.com:443", "10.0.0.1:80", "300.1.1.1", "[::1]", "ex_ample.com", "..example.com"]) {
      expect(proxyBypassSyntaxProblem(entry), entry).toBeDefined();
    }
  });

  it("says what to write instead for a wildcard and for a port", () => {
    expect(proxyBypassSyntaxProblem("*.example.com")).toContain("leading dot");
    expect(proxyBypassSyntaxProblem("example.com:443")).toContain("list the host alone");
  });
});

describe("proxyBypassName", () => {
  it("is the lowercased name an entry covers, without its leading dot", () => {
    expect(proxyBypassName(".Example.COM")).toBe("example.com");
  });

  it("is undefined for an IPv4 literal, which can cover no name", () => {
    expect(proxyBypassName("10.0.0.1")).toBeUndefined();
  });
});

describe("launch.proxyBypass in a configuration file", () => {
  it("is read as a list of hosts and fails the load, naming the entry, when one is malformed", () => {
    expect(ConfigProfileSchema.parse({ launch: { proxyBypass: ["mcp.example.com"] } }).launch?.proxyBypass).toEqual(["mcp.example.com"]);
    const bad = ConfigProfileSchema.safeParse({ launch: { proxyBypass: ["mcp.example.com", "https://x.example.com"] } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain('"https://x.example.com"');
  });
});
