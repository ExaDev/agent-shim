/** The longest a DNS name may be, and the longest one of its labels (RFC 1035). */
const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/** The largest value of one IPv4 octet. */
const MAX_OCTET = 255;

const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DIGITS_RE = /^\d+$/;

/** Whether `name` is a DNS name: dot-separated labels of letters, digits and inner hyphens, the last of them not all digits, since a name that ends in a number is a malformed address (an octet out of range), not a host. */
function isDnsName(name: string): boolean {
  const labels = name.split(".");
  return name.length <= MAX_NAME_LENGTH && labels.every((label) => label.length <= MAX_LABEL_LENGTH && LABEL_RE.test(label)) && !DIGITS_RE.test(labels.at(-1) ?? "");
}

/** Whether `host` is an IPv4 literal with every octet in range. */
function isIpv4(host: string): boolean {
  return IPV4_RE.test(host) && host.split(".").every((octet) => Number(octet) <= MAX_OCTET);
}

/**
 * What is wrong with one `NO_PROXY` entry a launch is asked to add, or undefined when it is acceptable. An entry is a DNS name, optionally with one leading `.` to cover its subdomains, or an IPv4 literal. Everything else is refused rather than passed through, because a client that does not understand a form ignores the entry without a word, and the host then stays on the door: Claude Code's runtime honours an exact name, a bare parent domain and a leading-dot domain, but not `*.domain` (its wildcard), a `:port`, or any case other than the one the request used. A lone `*` would take every host off the door, provider traffic included.
 */
export function proxyBypassSyntaxProblem(entry: string): string | undefined {
  if (entry === "" || entry !== entry.trim()) {
    return "is empty or has surrounding whitespace";
  }
  if (entry === "*") {
    return "would take every host off the door, provider traffic included";
  }
  if (entry.startsWith("*")) {
    return "uses a wildcard; write the domain with a leading dot (.example.com) to cover its subdomains";
  }
  if (/[\s,/@?#[\]]/.test(entry) || entry.includes("://")) {
    return "is not a host: it contains whitespace, a comma, a bracket, a scheme, a path or a credential";
  }
  if (entry.includes(":")) {
    return "has a port, which the proxy variable cannot express: list the host alone";
  }
  return isIpv4(entry) || isDnsName(entry.replace(/^\./, "")) ? undefined : "is not a host name or an IPv4 address";
}

/** The lowercased DNS name an accepted entry covers, without its leading dot: what a launch compares against the hosts the door must keep. Undefined for an IPv4 literal, which can never cover a name. */
export function proxyBypassName(entry: string): string | undefined {
  return isIpv4(entry) ? undefined : entry.replace(/^\./, "").toLowerCase();
}
