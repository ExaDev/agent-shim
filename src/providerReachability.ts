import { isHttpProvider, type HttpProvider, type Provider } from "./config/schema";
import { displayBaseUrl } from "./baseUrlDisplay";
import { probeAddressAcceptSync, type ListenerVerdict } from "./frontdoor/probe";

/**
 * The retransmission timeout a TCP sender uses before it has measured any round trip, which is the case for every connection's SYN: RFC 6298 section 2.1 sets it to one second, and both macOS and Linux start their SYN retransmissions from it.
 */
export const TCP_INITIAL_RETRANSMISSION_TIMEOUT_MS = 1_000;

/**
 * How many lost SYNs (or SYN-ACKs) in a row a connect to a provider survives before the provider counts as down. One loss is ordinary on a busy link and a second in a row is rare; a host that has not answered the original SYN and two retransmissions is not reachable, whatever the operating system would go on waiting for (75 s on macOS).
 */
export const CONNECT_SYN_RETRANSMISSIONS_TOLERATED = 2;

/**
 * The default bound on opening a TCP connection to a provider's base URL: the original SYN and each tolerated retransmission, each waiting the backed-off timeout (the initial timeout doubling per retransmission, RFC 6298 section 5.5), so the sum is the initial timeout times `2^(n+1) - 1`. Any reachable host (loopback, LAN or a remote API, whose round trip is far inside the initial timeout) answers well within it.
 */
export const DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS = TCP_INITIAL_RETRANSMISSION_TIMEOUT_MS * (2 ** (CONNECT_SYN_RETRANSMISSIONS_TOLERATED + 1) - 1);

/** The bound on opening a connection to `provider`'s base URL: its own `connectTimeoutMs`, else the derived default. */
export function providerConnectTimeoutMs(provider: Readonly<Pick<HttpProvider, "connectTimeoutMs">>): number {
  return provider.connectTimeoutMs ?? DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS;
}

/** The default port of each scheme a base URL may use, for a URL that names none. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/** The host and port a base URL's connections are opened to, an IPv6 literal without the brackets the URL form needs; undefined for a scheme that is neither http nor https, which nothing dials. */
export function dialTargetOf(baseUrl: string): { readonly host: string; readonly port: number } | undefined {
  const url = new URL(baseUrl);
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) {
    return undefined;
  }
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: url.port === "" ? defaultPort : Number(url.port) };
}

/** The one line every surface (the door's answer and its log, `doctor`, `check` and a launch) says when a connection to an upstream could not be opened. `subject` names what was dialled (`provider spark`); the base URL is named as `displayBaseUrl` shows it, without its userinfo or query. */
export function couldNotConnectMessage(subject: string, baseUrl: string, reason: string): string {
  return `${subject} could not connect to ${displayBaseUrl(baseUrl)}: ${reason}`;
}

/** Opens one TCP connection to `baseUrl`'s host and port within `timeoutMs` and closes it at once, sending nothing. */
export type BaseUrlProbe = (baseUrl: string, timeoutMs: number) => ListenerVerdict;

/** The real probe: a connect on a worker thread the calling thread blocks on, refused in a process whose event loop serves others. */
export const realBaseUrlProbe: BaseUrlProbe = (baseUrl, timeoutMs) => {
  const target = dialTargetOf(baseUrl);
  if (target === undefined) {
    return { ok: false, reason: "the base URL is neither http nor https" };
  }
  return probeAddressAcceptSync(target.host, target.port, timeoutMs);
};

/** Whether a provider's base URL accepts a connection within its connect bound, with the line to report when it does not. */
export type ProviderReachability = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Probes one http provider's base URL with `probe`, bounded by the provider's own connect timeout. */
export function probeProviderReachability(name: string, provider: Readonly<Pick<HttpProvider, "baseUrl" | "connectTimeoutMs">>, probe: BaseUrlProbe): ProviderReachability {
  const verdict = probe(provider.baseUrl, providerConnectTimeoutMs(provider));
  return verdict.ok ? { ok: true } : { ok: false, message: couldNotConnectMessage(`provider ${name}`, provider.baseUrl, verdict.reason) };
}

/** The line to report when `provider` is an http provider whose base URL accepts no connection; undefined when it accepts one, when the provider dials no base URL, or when no probe was given. */
export function unreachableProviderLine(name: string, provider: Provider, probe: BaseUrlProbe | undefined): string | undefined {
  if (probe === undefined || !isHttpProvider(provider)) {
    return undefined;
  }
  const reachability = probeProviderReachability(name, provider, probe);
  return reachability.ok ? undefined : reachability.message;
}
