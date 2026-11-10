/** The longest a label may be (RFC 1035). */
const MAX_LABEL_LENGTH = 63;

/** The longest a name may be in its dotted form (RFC 1035). */
const MAX_NAME_LENGTH = 253;

/** The parts of a dotted-decimal IPv4 address. */
const IPV4_PARTS = 4;

/** The largest value of one part of a dotted-decimal IPv4 address. */
const MAX_OCTET = 255;

/** One label of a reg-name: letters, digits and underscores (RFC 3986 unreserved, and what compose and Kubernetes service names use), with hyphens only inside. Compared case-insensitively. */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i;

/** A last label spelling a number in any base: decimal digits, or hexadecimal with the `0x` prefix. The WHATWG URL parser reads such a host as an IPv4 address, so a host ending in one is a number or nothing. */
const NUMERIC_LAST_LABEL = /^(?:\d+|0x[0-9a-f]*)$/i;

/** One part of a dotted-decimal address: decimal digits with no leading zero, which would read as octal. */
const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;

/**
 * Whether `host` is a dotted-decimal IPv4 address: four decimal parts of 0 to 255, none with a leading zero. Every other numeric spelling of an address (`127.1`, `0x7f.1`, an integer, an octal part) is not an address here, since the dial would resolve it to one the writer never wrote.
 */
export function isDottedDecimalIpv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === IPV4_PARTS && parts.every((part) => IPV4_PART.test(part) && Number(part) <= MAX_OCTET);
}

/**
 * What is wrong with `name` as a DNS name, or undefined when it is one: the one grammar every place that takes a host name shares (a CONNECT authority, a `NO_PROXY` entry). Dot-separated labels of 1 to 63 characters (253 in all) of letters, digits, underscores and interior hyphens, case-insensitive, the last label not a number in any base (a name that ends in one is a malformed address, not a host). It is the name alone: a trailing root dot, a leading dot or wildcard, a port and the conversion of an internationalised name to ASCII are each the caller's to handle before or around this check, and a dotted-decimal address is told apart by `isDottedDecimalIpv4` before it. The reason is fixed text, never the name.
 */
export function dnsNameProblem(name: string): string | undefined {
  if (name.length > MAX_NAME_LENGTH) {
    return `a host longer than ${String(MAX_NAME_LENGTH)} characters`;
  }
  const labels = name.split(".");
  if (labels.some((label) => label.length > MAX_LABEL_LENGTH)) {
    return `a host with a label longer than ${String(MAX_LABEL_LENGTH)} characters`;
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return "a host that is not letters, digits, underscores and interior hyphens in non-empty dot-separated labels";
  }
  if (NUMERIC_LAST_LABEL.test(labels[labels.length - 1] ?? "")) {
    return "a numeric host that is not a dotted-decimal IPv4 address";
  }
  return undefined;
}
