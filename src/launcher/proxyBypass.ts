import { proxyBypassName, proxyBypassSyntaxProblem } from "../config/proxyBypass";
import { UsageError } from "../cliError";
import { CONNECT_INTERCEPT_HOSTS } from "../frontdoor/connect";

/**
 * Checks the hosts a launch is asked to keep off the door and returns them lowercased and without duplicates, in the order given. `source` names where they came from (`launch.proxyBypass`, `AGENT_SHIM_PROXY_BYPASS`) so a refusal says what to fix. Throws `UsageError` for an entry that is malformed (see `proxyBypassSyntaxProblem`) or that covers a host the door must keep (the intercepted hosts: leaving one off the door would break the session's API calls or its Remote Control channel): an exact match, or a parent domain, since clients match a bare domain against its subdomains.
 */
export function checkedProxyBypass(entries: readonly string[], source: string): readonly string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of entries) {
    const problem = proxyBypassSyntaxProblem(entry);
    if (problem !== undefined) {
      throw new UsageError(`${source}: "${entry}" ${problem}.`);
    }
    const name = proxyBypassName(entry);
    const covered = name === undefined ? undefined : CONNECT_INTERCEPT_HOSTS.find((keptHost) => keptHost === name || keptHost.endsWith(`.${name}`));
    if (covered !== undefined) {
      throw new UsageError(`${source}: "${entry}" would take ${covered} off the door, and a session needs the door for it.`);
    }
    // Lowercased because the runtime matches names case-sensitively against the lowercase host a request carries, so a mixed-case entry would be silently ignored.
    const host = entry.toLowerCase();
    if (!seen.has(host)) {
      seen.add(host);
      kept.push(host);
    }
  }
  return kept;
}

/** `existing` (a comma-separated `NO_PROXY` value) with `hosts` appended when it does not already list them, compared without case, keeping what was there in the order it was. */
export function withBypassHosts(existing: string | undefined, hosts: readonly string[]): string {
  const listed = (existing ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  const have = new Set(listed.map((entry) => entry.toLowerCase()));
  const added = hosts.filter((host) => {
    const key = host.toLowerCase();
    if (have.has(key)) {
      return false;
    }
    have.add(key);
    return true;
  });
  return [...listed, ...added].join(",");
}
