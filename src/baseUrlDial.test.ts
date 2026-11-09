import { describe, expect, it } from "vitest";

import { dialHostOf, dialTargetOf, parseDialAuthority } from "./baseUrlDial";

const HTTPS_PORT = 443;

describe("parseDialAuthority", () => {
  it("takes a name, a port and the default port of a bare host", () => {
    expect(parseDialAuthority("Api.Example.COM:8443", HTTPS_PORT)).toEqual({ host: "api.example.com", port: 8443 });
    expect(parseDialAuthority("api.example.com", HTTPS_PORT)).toEqual({ host: "api.example.com", port: HTTPS_PORT });
    expect(parseDialAuthority("127.0.0.1:80", HTTPS_PORT)).toEqual({ host: "127.0.0.1", port: 80 });
  });

  it("strips exactly one pair of brackets from an IPv6 literal", () => {
    expect(parseDialAuthority("[::1]:8443", HTTPS_PORT)).toEqual({ host: "::1", port: 8443 });
    expect(parseDialAuthority("[::1]", HTTPS_PORT)).toEqual({ host: "::1", port: HTTPS_PORT });
    expect(parseDialAuthority("[2001:DB8::7]:1", HTTPS_PORT)).toEqual({ host: "2001:db8::7", port: 1 });
  });

  it("spells a v4-mapped literal as a URL does", () => {
    expect(parseDialAuthority("[::ffff:127.0.0.1]:9", HTTPS_PORT)).toEqual({ host: "::ffff:7f00:1", port: 9 });
  });

  it("keeps a zone id's case and takes its RFC 6874 escaped percent sign", () => {
    expect(parseDialAuthority("[fe80::1%25Eth0]:9", HTTPS_PORT)).toEqual({ host: "fe80::1%Eth0", port: 9 });
    expect(parseDialAuthority("[fe80::1%Eth0]:9", HTTPS_PORT)).toEqual({ host: "fe80::1%Eth0", port: 9 });
  });

  it.each([
    ["", "names no host"],
    [":443", "names no host"],
    ["host:", "no port after the colon"],
    ["host:abc", "not a number"],
    ["host:443abc", "not a number"],
    ["host:0", "outside 1 to 65535"],
    ["host:65536", "outside 1 to 65535"],
    ["host:-1", "not a number"],
    ["a:b:c", "unbracketed IPv6 literal"],
    ["::1", "unbracketed IPv6 literal"],
    ["::1:443", "unbracketed IPv6 literal"],
    ["[::1", "unterminated bracket"],
    ["[::1]x", "after the closing bracket"],
    ["[::1]:", "no port after the colon"],
    ["[::1]:abc", "not a number"],
    ["[]:443", "names no host"],
    ["[example.com]:443", "not an IPv6 literal"],
    ["[[::1]]:443", "not an IPv6 literal"],
    ["[127.0.0.1]:443", "not an IPv6 literal"],
    ["user@host:443", "userinfo"],
    ["user:pw@[::1]:443", "userinfo"],
    ["ho]st:443", "brackets"],
    ["ho[st:443", "brackets"],
    ["host name:443", "whitespace"],
    ["host/path:443", "path"],
  ])("refuses %j, naming the problem (%s)", (authority, problem) => {
    const parsed = parseDialAuthority(authority, HTTPS_PORT);
    expect(parsed).toHaveProperty("refusal");
    expect(JSON.stringify(parsed)).toContain(problem);
  });
});

describe("dialHostOf", () => {
  it("is the same host rule the authority parser applies", () => {
    expect(dialHostOf(new URL("http://[::1]:8080/x"))).toBe("::1");
    expect(dialHostOf(new URL("http://[::ffff:7f00:1]/"))).toBe("::ffff:7f00:1");
    expect(dialHostOf(new URL("http://example.com/"))).toBe("example.com");
    expect(dialTargetOf("https://[::1]/")).toEqual({ host: "::1", port: HTTPS_PORT });
  });
});
