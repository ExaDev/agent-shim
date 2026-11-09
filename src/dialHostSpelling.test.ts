import { describe, expect, it } from "vitest";

import { dialHostOf, parseDialAuthority } from "./baseUrlDial";

const PORT = 443;

/** Hosts both a URL and an authority can spell, each with the host a dial to it uses. */
const SAME_HOST: readonly (readonly [string, string])[] = [
  ["api.anthropic.com", "api.anthropic.com"],
  ["API.Anthropic.COM", "api.anthropic.com"],
  ["api.anthropic.com.", "api.anthropic.com"],
  ["platform.claude.com.", "platform.claude.com"],
  ["localhost", "localhost"],
  ["localhost.", "localhost"],
  ["a", "a"],
  ["a-b.example", "a-b.example"],
  ["xn--bcher-kva.example", "xn--bcher-kva.example"],
  ["bücher.example", "xn--bcher-kva.example"],
  ["BÜCHER.example.", "xn--bcher-kva.example"],
  ["münchen.de", "xn--mnchen-3ya.de"],
  ["例え.jp", "xn--r8jz45g.jp"],
  ["127.0.0.1", "127.0.0.1"],
  ["127.0.0.1.", "127.0.0.1"],
  ["10.0.0.255", "10.0.0.255"],
  ["0.0.0.0", "0.0.0.0"],
  ["255.255.255.255", "255.255.255.255"],
  ["host1", "host1"],
  ["1host", "1host"],
  ["a1.b2.c3", "a1.b2.c3"],
  ["x.y.z.example.org", "x.y.z.example.org"],
  ["0x.example", "0x.example"],
  ["123abc.example", "123abc.example"],
  ["example.com1", "example.com1"],
  ["[::1]", "::1"],
  ["[2001:DB8::1]", "2001:db8::1"],
  ["[::ffff:127.0.0.1]", "::ffff:7f00:1"],
  ["[fe80::1]", "fe80::1"],
  ["[::]", "::"],
  ["[0:0:0:0:0:0:0:1]", "::1"],
];

/** Hosts an authority refuses because the dial would resolve them to an address the authority never wrote. */
const NUMERIC_SHORTHAND: readonly string[] = ["127.1", "0x7f.1", "0x7f000001", "2130706433", "017700000001", "127.0.1", "1.2.3", "256.1.1.1", "1.2.3.4.5", "010.0.0.1", "0x7f.0x0.0x0.0x1", "1"];

describe("one host, one spelling, wherever it is read", () => {
  it.each(SAME_HOST)("dials %s as %s from an authority and from a URL", (written, dialled) => {
    const fromAuthority = parseDialAuthority(`${written}:8443`, PORT);
    expect(fromAuthority).toEqual({ host: dialled, port: 8443 });
    expect(dialHostOf(new URL(`https://${written}:8443/`))).toBe(dialled);
  });

  it.each(NUMERIC_SHORTHAND)("refuses %s as a CONNECT host rather than dial an address it was never written as", (host) => {
    const parsed = parseDialAuthority(`${host}:${String(PORT)}`, PORT);
    expect(parsed).toHaveProperty("refusal");
  });

  it("refuses a name that does not convert to ASCII", () => {
    for (const host of ["\u200d.example", "\u0378.example", "\ud800.example"]) {
      expect(parseDialAuthority(host, PORT), host).toHaveProperty("refusal");
    }
  });

  it("keeps a zone id's case and spelling", () => {
    expect(parseDialAuthority("[fe80::1%Eth0]:1", PORT)).toEqual({ host: "fe80::1%Eth0", port: 1 });
  });

  it("refuses the root alone and a doubled root dot", () => {
    expect(parseDialAuthority(".", PORT)).toHaveProperty("refusal");
    expect(parseDialAuthority("a..", PORT)).toHaveProperty("refusal");
  });
});
