import { isHttpProvider, type HttpProvider, type Provider } from "./config/schema";
import { dialTargetOf } from "./baseUrlDial";
import { displayBaseUrl } from "./baseUrlDisplay";
import { startAddressProbes, type ListenerVerdict, type ProbeWorkers, type StartedProbe } from "./frontdoor/probe";

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

/** The one line every surface (the door's answer and its log, `doctor`, `check` and a launch) says when a connection to an upstream could not be opened. `subject` names what was dialled (`provider spark`); the base URL is named as `displayBaseUrl` shows it. */
export function couldNotConnectMessage(subject: string, baseUrl: string, reason: string): string {
  return `${subject} could not connect to ${displayBaseUrl(baseUrl)}: ${reason.trim() === "" ? "the connection failed with no reason given" : reason}`;
}

/** Opens one TCP connection to `baseUrl`'s host and port within `timeoutMs` and closes it at once, sending nothing. */
export type BaseUrlProbe = (baseUrl: string, timeoutMs: number) => ListenerVerdict;

/** One base URL to probe, within its own bound. */
export interface BaseUrlTarget {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

/** `BaseUrlProbe` for several base URLs: up to `MAX_CONCURRENT_PROBES` distinct targets run together and any more follow in rounds of that many, so the worst case is the longest bound times the number of rounds; verdicts in the order the targets were given. */
export type BaseUrlBatchProbe = (targets: readonly BaseUrlTarget[]) => readonly ListenerVerdict[];

/** The port no listener has and no connection can be made to: a URL accepts `:0`, and the system refuses to connect to it. */
const NO_LISTENER_PORT = 0;

/** The verdict for a base URL that names port 0. */
const PORT_ZERO: ListenerVerdict = { ok: false, reason: "the base URL names port 0, which nothing listens on" };

/** The verdict for a base URL whose scheme nothing dials. */
const UNDIALLABLE: ListenerVerdict = { ok: false, reason: "the base URL is neither http nor https" };

/** A batch of base-URL probes that has been started: `verdicts` blocks until every one is in and returns them in the order of the targets; `cancel` ends the workers of a batch nobody will wait on. */
export interface StartedBaseUrlBatchProbe {
  readonly verdicts: () => readonly ListenerVerdict[];
  readonly cancel: () => void;
}

/** Starts the real batch probe, returning before it has waited on any verdict so the caller can work meanwhile (see `realBaseUrlBatchProbe`, which waits straight away), with the source of its workers injectable so a test can observe their order: each connect on a worker thread, up to `MAX_CONCURRENT_PROBES` of them started before the calling thread blocks on the first, refused in a process whose event loop serves others. */
export const startBaseUrlBatchProbe = (targets: readonly BaseUrlTarget[], workers?: ProbeWorkers): StartedBaseUrlBatchProbe => {
  const dialled = targets.map((target) => ({ dial: dialTargetOf(target.baseUrl), timeoutMs: target.timeoutMs }));
  const probed = dialled.filter((entry) => entry.dial !== undefined && entry.dial.port !== NO_LISTENER_PORT);
  const started = startAddressProbes(probed.flatMap((entry) => (entry.dial === undefined ? [] : [{ ...entry.dial, timeoutMs: entry.timeoutMs }])), workers);
  return {
    cancel: started.cancel,
    verdicts: () => {
      const verdicts = started.settle();
      let next = 0;
      return dialled.map((entry) => {
        if (entry.dial === undefined) {
          return UNDIALLABLE;
        }
        if (entry.dial.port === NO_LISTENER_PORT) {
          return PORT_ZERO;
        }
        const verdict = verdicts[next];
        next += 1;
        if (verdict === undefined) {
          throw new Error("the batch probe answered fewer verdicts than it was given addresses");
        }
        return verdict;
      });
    },
  };
};

/** The real batch probe: each connect on a worker thread, up to `MAX_CONCURRENT_PROBES` of them started before the calling thread blocks on the first verdict. */
export const realBaseUrlBatchProbe = (targets: readonly BaseUrlTarget[], workers?: ProbeWorkers): readonly ListenerVerdict[] => startBaseUrlBatchProbe(targets, workers).verdicts();

/** Starts a probe of one base URL within `timeoutMs` without waiting for it: `verdict` blocks until it answers, `cancel` ends its worker. */
export type StartBaseUrlProbe = (baseUrl: string, timeoutMs: number) => StartedProbe;

/** The real start of a one-URL probe: a batch of one. */
export const realStartBaseUrlProbe: StartBaseUrlProbe = (baseUrl, timeoutMs) => {
  const started = startBaseUrlBatchProbe([{ baseUrl, timeoutMs }]);
  return {
    cancel: started.cancel,
    verdict: () => {
      const [verdict] = started.verdicts();
      if (verdict === undefined) {
        throw new Error("the batch probe answered no verdict for one base URL");
      }
      return verdict;
    },
  };
};

/** The real probe of one base URL: it waits for the verdict as soon as it has started it. */
export const realBaseUrlProbe: BaseUrlProbe = (baseUrl, timeoutMs) => realStartBaseUrlProbe(baseUrl, timeoutMs).verdict();

/** Whether a provider's base URL accepts a connection within its connect bound, with the line to report when it does not. */
export type ProviderReachability = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Probes one http provider's base URL with `probe`, bounded by the provider's own connect timeout. */
export function probeProviderReachability(name: string, provider: Readonly<Pick<HttpProvider, "baseUrl" | "connectTimeoutMs">>, probe: BaseUrlProbe): ProviderReachability {
  const verdict = probe(provider.baseUrl, providerConnectTimeoutMs(provider));
  return verdict.ok ? { ok: true } : { ok: false, message: couldNotConnectMessage(`provider ${name}`, provider.baseUrl, verdict.reason) };
}

/** A launch's reachability check of its provider, started and not yet read: `line` blocks until the probe answers and gives the line to report when the base URL accepts no connection (undefined when it does); `cancel` ends the probe's worker where nobody will read it. */
export interface StartedProviderReachability {
  readonly line: () => string | undefined;
  readonly cancel: () => void;
}

/** Starts the check of `provider`'s base URL, bounded by the provider's own connect timeout; undefined when the provider dials no base URL or no `start` was given. */
export function startProviderReachability(name: string, provider: Provider, start: StartBaseUrlProbe | undefined): StartedProviderReachability | undefined {
  if (start === undefined || !isHttpProvider(provider)) {
    return undefined;
  }
  const started = start(provider.baseUrl, providerConnectTimeoutMs(provider));
  return {
    cancel: started.cancel,
    line: () => {
      const verdict = started.verdict();
      return verdict.ok ? undefined : couldNotConnectMessage(`provider ${name}`, provider.baseUrl, verdict.reason);
    },
  };
}

/** The line to report for each of `providers` whose base URL accepts no connection, by name, from one batch probe of every http provider among them, each within its own connect bound. A provider that dials no base URL, or that accepts a connection, has no line. */
export function probeProviderReachabilities(providers: readonly { readonly name: string; readonly provider: Provider }[], probe: BaseUrlBatchProbe): ReadonlyMap<string, string> {
  const http = providers.flatMap((entry) => (isHttpProvider(entry.provider) ? [{ name: entry.name, provider: entry.provider }] : []));
  const verdicts = probe(http.map((entry) => ({ baseUrl: entry.provider.baseUrl, timeoutMs: providerConnectTimeoutMs(entry.provider) })));
  const lines = new Map<string, string>();
  http.forEach((entry, index) => {
    const verdict = verdicts[index];
    if (verdict === undefined) {
      throw new Error("the batch probe answered fewer verdicts than it was given base URLs");
    }
    if (!verdict.ok) {
      lines.set(entry.name, couldNotConnectMessage(`provider ${entry.name}`, entry.provider.baseUrl, verdict.reason));
    }
  });
  return lines;
}
