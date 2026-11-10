import { isIPv6 } from "node:net";
import { domainToASCII } from "node:url";

/** The largest port a TCP listener can have. */
export const MAX_TCP_PORT = 65535;

/**
 * The host a connection to `url` is opened to: its hostname, an IPv6 literal without the brackets the URL form needs. This is the one rule that turns a URL's host, or a CONNECT authority's (`parseDialAuthority`), into a dial target: `net.isIP("[::1]")` is 0, so a bracketed literal is taken for a name, goes to the resolver and fails with EBADNAME, whichever side dials it. A `URL` hostname is already well formed, so one pair of brackets round a colon-bearing literal is removed and nothing else changes.
 */
export function dialHostOf(url: Readonly<Pick<URL, "hostname">>): string {
  return withoutRootDot(url.hostname.replace(/^\[(.*)\]$/, "$1"));
}

/** `host` without the one trailing dot that names the DNS root: `api.anthropic.com.` is the same host as `api.anthropic.com` and must compare equal to it. */
function withoutRootDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** One authority as a dial target. */
export interface DialAuthority {
  readonly host: string;
  readonly port: number;
}

/** An authority that cannot be dialled, with the problem named; never echoes the authority, which a caller may write into a response. */
export interface DialAuthorityRefusal {
  readonly refusal: string;
}

/** The characters an authority never holds: whitespace, a path, a query or a fragment. */
const NOT_AUTHORITY = /[\s/?#\\]/;

/** The zone id of a link-local literal arrives percent-escaped (`%25`, RFC 6874) in a URI and bare in a socket address; the dial takes the bare form. */
function bareZone(literal: string): string {
  return literal.replace("%25", "%");
}

/** A port written as decimal digits only and inside the TCP range, or the problem. */
function portOf(text: string): number | string {
  if (text === "") {
    return "has no port after the colon";
  }
  if (!/^\d+$/.test(text)) {
    return "has a port that is not a number";
  }
  const port = Number(text);
  return port >= 1 && port <= MAX_TCP_PORT ? port : `has a port outside 1 to ${String(MAX_TCP_PORT)}`;
}

/** The longest a label may be (RFC 1035). */
export const MAX_LABEL_LENGTH = 63;

/** The longest a name may be in its dotted form (RFC 1035). */
export const MAX_NAME_LENGTH = 253;

/** The parts of a dotted-decimal IPv4 address. */
const IPV4_PARTS = 4;

/** The largest value of one part of a dotted-decimal IPv4 address. */
const MAX_OCTET = 255;

/** One label of a reg-name: letters, digits and underscores (RFC 3986 unreserved, and what compose and Kubernetes service names use), with hyphens only inside. */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

/** A dotted-decimal IPv4 address: four decimal parts of 0 to 255, none with a leading zero. */
function isDottedDecimal(host: string): boolean {
  const parts = host.split(".");
  return parts.length === IPV4_PARTS && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= MAX_OCTET);
}

/** Whether every character of `text` is ASCII, so an internationalised name is told from one that already is. */
function isAscii(text: string): boolean {
  return /^\p{ASCII}*$/u.test(text);
}

/** A last label spelling a number in any base: decimal digits, or hexadecimal with the `0x` prefix. The WHATWG URL parser reads such a host as an IPv4 address, so a host ending in one is a number or nothing. */
const NUMERIC_LAST_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;

/**
 * The canonical host an unbracketed authority names, or the refusal: lowercased, one trailing root dot removed, an internationalised name converted to its ASCII form, so the same host spelt two ways dials and compares as one. The grammar is positive: a reg-name of letters, digits, underscores and interior hyphens in labels of 1 to 63 characters (253 in all), or a dotted-decimal IPv4 address. A numeric shorthand (`127.1`, `0x7f.1`, a decimal or octal integer) is refused rather than read, since the dial would resolve it to an address the authority never wrote. Nothing else is dialled, so a byte `net.connect` would throw on (a NUL, a control character, a percent escape, a comma, a wildcard, an empty label) is refused with the 400 the client is owed instead of an accept followed by a drop.
 */
function nameOf(host: string): string | DialAuthorityRefusal {
  const rooted = withoutRootDot(host.toLowerCase());
  if (rooted === "") {
    return { refusal: "an authority that names no host" };
  }
  const lowered = isAscii(rooted) ? rooted : domainToASCII(rooted);
  if (lowered === "") {
    return { refusal: "a host that does not convert to an ASCII name" };
  }
  if (isDottedDecimal(lowered)) {
    return lowered;
  }
  if (lowered.length > MAX_NAME_LENGTH) {
    return { refusal: `a host longer than ${String(MAX_NAME_LENGTH)} characters` };
  }
  const labels = lowered.split(".");
  if (labels.some((label) => label.length > MAX_LABEL_LENGTH)) {
    return { refusal: `a host with a label longer than ${String(MAX_LABEL_LENGTH)} characters` };
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return { refusal: "a host that is not letters, digits, underscores and interior hyphens in non-empty dot-separated labels" };
  }
  if (NUMERIC_LAST_LABEL.test(labels[labels.length - 1] ?? "")) {
    return { refusal: "a numeric host that is not a dotted-decimal IPv4 address" };
  }
  return lowered;
}

/** An IPv6 literal in the spelling a URL gives it (compressed, lowercase, a v4-mapped tail as hex), so the same address written two ways is one host; a literal with a zone id keeps its own spelling, which a URL cannot hold, with the zone's case kept. */
function canonicalLiteral(literal: string): string {
  return literal.includes("%") ? lowerHost(literal) : dialHostOf(new URL(`http://[${literal}]/`));
}

/** Lowercases a host but not its zone id, which names an interface and is case-sensitive. */
function lowerHost(host: string): string {
  const zone = host.indexOf("%");
  return zone === -1 ? host.toLowerCase() : `${host.slice(0, zone).toLowerCase()}${host.slice(zone)}`;
}

/**
 * Parses an authority (`host`, `host:port`, `[v6]` or `[v6]:port`) into the host and port a connection to it is opened to, `defaultPort` when it names none. A CONNECT request line's authority and a URL's host take the same rule: an IPv6 literal is bracketed and its brackets are removed once, here, so what comes back is what `net.connect` takes. An unbracketed host holding a colon beyond the port's is refused, since `a:b:c` has no unambiguous reading, as are userinfo, a path, whitespace, a port outside the TCP range and every unbalanced or misplaced bracket. The host is lowercased, its zone id aside.
 */
export function parseDialAuthority(authority: string, defaultPort: number): DialAuthority | DialAuthorityRefusal {
  if (authority.includes("@")) {
    return { refusal: "an authority with userinfo cannot be dialled" };
  }
  if (NOT_AUTHORITY.test(authority)) {
    return { refusal: "an authority holds whitespace, a path, a query or a fragment" };
  }
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) {
      return { refusal: "an authority with an unterminated bracket" };
    }
    const literal = bareZone(authority.slice(1, close));
    const rest = authority.slice(close + 1);
    if (literal === "") {
      return { refusal: "an authority that names no host" };
    }
    if (!isIPv6(literal)) {
      return { refusal: "a bracketed host that is not an IPv6 literal" };
    }
    if (rest !== "" && !rest.startsWith(":")) {
      return { refusal: "an authority with text after the closing bracket other than a port" };
    }
    const port = rest === "" ? defaultPort : portOf(rest.slice(1));
    return typeof port === "string" ? { refusal: `an authority that ${port}` } : { host: canonicalLiteral(literal), port };
  }
  const colons = authority.split(":").length - 1;
  if (colons > 1) {
    return { refusal: "an unbracketed IPv6 literal, which must be written in brackets" };
  }
  const colon = authority.indexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (host === "") {
    return { refusal: "an authority that names no host" };
  }
  if (/[[\]]/.test(host)) {
    return { refusal: "an authority with brackets round something other than an IPv6 literal" };
  }
  const name = nameOf(host);
  if (typeof name !== "string") {
    return name;
  }
  const port = colon === -1 ? defaultPort : portOf(authority.slice(colon + 1));
  return typeof port === "string" ? { refusal: `an authority that ${port}` } : { host: name, port };
}

/** The default port of each scheme a base URL may use, for a URL that names none. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/**
 * The host and port a base URL's connections are opened to. The URL is an `http` provider's base URL, which the schema holds to http or https and a port a listener can have (`HttpBaseUrlSchema`), so any other scheme is a caller's fault and throws.
 */
export function dialTargetOf(baseUrl: string): { readonly host: string; readonly port: number } {
  const url = new URL(baseUrl);
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) {
    throw new Error(`${url.protocol} is not a scheme a provider's base URL can have`);
  }
  return { host: dialHostOf(url), port: url.port === "" ? defaultPort : Number(url.port) };
}
