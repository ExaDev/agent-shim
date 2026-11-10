import * as net from "node:net";
import { describe, expect, it } from "vitest";

import { MAX_LABEL_LENGTH, MAX_NAME_LENGTH, parseDialAuthority } from "./baseUrlDial";
import { MALFORMED_WITH_MARKER, MARKER } from "./dialAuthorityTestWorld";

const DEFAULT_PORT = 443;
const ASCII_END = 0x80;
const COLON = ":";

/** Every ASCII character, the control characters and DEL included, as a one-character string. */
const ASCII: readonly string[] = Array.from({ length: ASCII_END }, (_, code) => String.fromCharCode(code));

/** The grammar written a second time as the test's oracle, apart from the implementation: a letter or digit, or one of those with interior hyphens and dots. */
const ORACLE_SINGLE = /^[a-z_]$/i;
const ORACLE_MIDDLE = /^[a-z0-9._-]$/i;

describe("the host grammar of an unbracketed authority", () => {
  const cases = ASCII.filter((character) => character !== COLON);

  it.each(cases.map((character) => [JSON.stringify(character), character] as const))("takes %s alone as a host exactly when it is a letter or an underscore (a lone digit is a number)", (_name, character) => {
    const parsed = parseDialAuthority(`${character}:${String(DEFAULT_PORT)}`, DEFAULT_PORT);
    if (ORACLE_SINGLE.test(character)) {
      expect(parsed).toEqual({ host: character.toLowerCase(), port: DEFAULT_PORT });
    } else {
      expect(parsed).toHaveProperty("refusal");
    }
  });

  it.each(cases.map((character) => [JSON.stringify(character), character] as const))("takes %s inside a host exactly when a host may hold it there", (_name, character) => {
    const host = `a${character}b`;
    const parsed = parseDialAuthority(`${host}:${String(DEFAULT_PORT)}`, DEFAULT_PORT);
    if (ORACLE_MIDDLE.test(character)) {
      expect(parsed).toEqual({ host: host.toLowerCase(), port: DEFAULT_PORT });
    } else {
      expect(parsed).toHaveProperty("refusal");
    }
  });

  it.each(["a\0b", "%25", "host%20x", "host,evil", "*", "a..b", "-a", "a-", ".a", "a..", "a\u0007b"])("refuses %j", (host) => {
    expect(parseDialAuthority(`${host}:${String(DEFAULT_PORT)}`, DEFAULT_PORT), host).toHaveProperty("refusal");
  });

  it.each(["my_service", "_x.example", "a_b.c", "_", "__dmarc.example.org", "a-_-b"])("takes the underscore name %s", (host) => {
    expect(parseDialAuthority(`${host}:${String(DEFAULT_PORT)}`, DEFAULT_PORT)).toEqual({ host, port: DEFAULT_PORT });
  });

  it("holds a label to 63 characters and a name to 253", () => {
    const label = "a".repeat(MAX_LABEL_LENGTH);
    expect(parseDialAuthority(label, DEFAULT_PORT)).toEqual({ host: label, port: DEFAULT_PORT });
    expect(parseDialAuthority(`${label}a`, DEFAULT_PORT)).toHaveProperty("refusal");
    const labelsBefore = 3;
    const longest = [...Array.from({ length: labelsBefore }, () => label), "a".repeat(MAX_NAME_LENGTH - labelsBefore * (MAX_LABEL_LENGTH + 1))].join(".");
    expect(longest).toHaveLength(MAX_NAME_LENGTH);
    expect(parseDialAuthority(longest, DEFAULT_PORT)).toEqual({ host: longest, port: DEFAULT_PORT });
    expect(parseDialAuthority(`${longest}a`, DEFAULT_PORT)).toHaveProperty("refusal");
  });

  it("takes a dotted-decimal IPv4 address and no other numeric spelling of one", () => {
    expect(parseDialAuthority("127.0.0.1", DEFAULT_PORT)).toEqual({ host: "127.0.0.1", port: DEFAULT_PORT });
    expect(parseDialAuthority("255.255.255.255", DEFAULT_PORT)).toEqual({ host: "255.255.255.255", port: DEFAULT_PORT });
  });
});

/** A seeded generator (mulberry32), so a failing input is reproduced by its seed. */
function seededRandom(seed: number): () => number {
  const INCREMENT = 0x6d2b79f5;
  const SHIFT_A = 15;
  const SHIFT_B = 7;
  const SHIFT_C = 14;
  const MIX = 61;
  const RANGE = 4294967296;
  let state = seed;
  return () => {
    state = (state + INCREMENT) | 0;
    let t = Math.imul(state ^ (state >>> SHIFT_A), 1 | state);
    t = (t + Math.imul(t ^ (t >>> SHIFT_B), MIX | t)) ^ t;
    return ((t ^ (t >>> SHIFT_C)) >>> 0) / RANGE;
  };
}

describe("what the parser accepts, whatever it is given", () => {
  const SEED = 20240611;
  const INPUTS = 4000;
  const MAX_LENGTH = 24;
  const PORT_MAX = 65535;
  const CHARACTER_SHARE = 0.5;
  const FRAGMENTS = ["[", "]", ":", "::", "%", "%25", ".", "-", "..", "0x7f", "bücher", "\u0000", "@", "443", "127.0.0.1", "::1", "xn--"];

  function generate(random: () => number): string {
    const length = Math.floor(random() * MAX_LENGTH);
    let text = "";
    for (let index = 0; index < length; index += 1) {
      const pick = random();
      const fragment = FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? "";
      text += pick < CHARACTER_SHARE ? (ASCII[Math.floor(random() * ASCII_END)] ?? "") : fragment;
    }
    return text;
  }

  /** What `net.connect` validates before it does anything else, applied to a name by the real socket with a lookup that never resolves: a throw here is the throw a client would meet after being told 200. */
  function connectThrows(host: string, port: number): boolean {
    const socket = new net.Socket();
    socket.on("error", () => undefined);
    try {
      socket.connect({
        host,
        port,
        lookup: (_name, _options, callback) => {
          callback(new Error("never resolved"), "", 0);
        },
      });
      return false;
    } catch {
      return true;
    } finally {
      socket.destroy();
    }
  }

  it("never throws, and accepts no host that net.connect would throw on", () => {
    const random = seededRandom(SEED);
    let accepted = 0;
    for (let index = 0; index < INPUTS; index += 1) {
      const input = generate(random);
      const parsed = parseDialAuthority(input, DEFAULT_PORT);
      if ("refusal" in parsed) {
        continue;
      }
      accepted += 1;
      expect(parsed.port, input).toBeGreaterThanOrEqual(1);
      expect(parsed.port, input).toBeLessThanOrEqual(PORT_MAX);
      expect(net.isIP(parsed.host) !== 0 || !connectThrows(parsed.host, parsed.port), JSON.stringify(input)).toBe(true);
    }
    // The generator must reach the accept path, or the loop above proves nothing.
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("a refusal never repeats what the client sent", () => {
  it.each(MALFORMED_WITH_MARKER.map((authority) => [JSON.stringify(authority), authority] as const))("names the problem with %s without quoting it", (_name, authority) => {
    const parsed = parseDialAuthority(authority, DEFAULT_PORT);
    expect(parsed).toHaveProperty("refusal");
    if ("refusal" in parsed) {
      expect(parsed.refusal.toLowerCase()).not.toContain(MARKER);
      expect(parsed.refusal).not.toMatch(/\p{Cc}/u);
    }
  });
});
