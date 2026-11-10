import { dnsNameProblem, isDottedDecimalIpv4 } from "../hostName";

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
  return isDottedDecimalIpv4(entry) || dnsNameProblem(entry.replace(/^\./, "")) === undefined ? undefined : "is not a host name or an IPv4 address";
}

/** The lowercased DNS name an accepted entry covers, without its leading dot: what a launch compares against the hosts the door must keep. Undefined for an IPv4 literal, which can never cover a name. */
export function proxyBypassName(entry: string): string | undefined {
  return isDottedDecimalIpv4(entry) ? undefined : entry.replace(/^\./, "").toLowerCase();
}
