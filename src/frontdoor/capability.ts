import { createHash, timingSafeEqual } from "node:crypto";

/**
 * How a launch's capability token is presented and checked. The token reaches the child twice: as the `x-agent-shim-auth` header on every request it sends (see `AUTH_HEADER`), and as the password in the `HTTPS_PROXY` URL an OAuth launch gets, which every proxy-aware client turns into `Proxy-Authorization: Basic ...` on its CONNECT request. Both are checked against the same live registry with the same constant-time comparison.
 */

/** The user name in the proxy URL. A label only: the surface checks the password, which is the capability, and ignores the user name, so nothing depends on how a client spells it. */
export const CONNECT_PROXY_USER = "agent-shim";

/** The realm the CONNECT surface's 407 challenge names, so a client that waits for a challenge before sending credentials knows which ones to send. */
export const CONNECT_PROXY_REALM = "agent-shim front door";

/** The one authentication scheme the surface accepts, compared case-insensitively as RFC 9110 section 11.1 requires. */
const BASIC_SCHEME = "basic";

/**
 * The `HTTPS_PROXY` value for a launch: the CONNECT surface's loopback address with the capability as the URL's password. Both userinfo halves are percent-encoded, because a client percent-decodes userinfo before it builds the `Proxy-Authorization` value, so the surface receives exactly the token whatever characters it holds.
 */
export function connectProxyUrl(port: number, token: string): string {
  return `http://${encodeURIComponent(CONNECT_PROXY_USER)}:${encodeURIComponent(token)}@127.0.0.1:${String(port)}`;
}

/**
 * The capability a `Proxy-Authorization` header value presents: the password half of a Basic credential (everything after the first colon of the decoded user-pass, since RFC 7617 forbids a colon in the user name and permits one in the password). Undefined for any other scheme, a credential with no colon, or an empty password.
 */
export function capabilityFromProxyAuthorization(value: string): string | undefined {
  const trimmed = value.trim();
  const space = trimmed.indexOf(" ");
  if (space === -1 || trimmed.slice(0, space).toLowerCase() !== BASIC_SCHEME) {
    return undefined;
  }
  const userPass = Buffer.from(trimmed.slice(space + 1).trim(), "base64").toString("utf8");
  const colon = userPass.indexOf(":");
  if (colon === -1) {
    return undefined;
  }
  const password = userPass.slice(colon + 1);
  return password === "" ? undefined : password;
}

/** A fixed-length digest of a token, so the constant-time comparison never sees two buffers of different lengths (which `timingSafeEqual` refuses, and whose length difference would itself be a timing signal). */
function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Whether `presented` is one of the live capabilities, compared in constant time: every live token is compared against the presented one in full, with no early exit on a match or a mismatching prefix, so the time a check takes reveals neither which token matched nor how much of a guess was right.
 */
export function isLiveCapability(presented: string, live: Readonly<Iterable<string>>): boolean {
  const presentedDigest = digest(presented);
  let matched = false;
  for (const token of live) {
    // Evaluated before the `||`, so a match already found never short-circuits the remaining comparisons.
    const equal = timingSafeEqual(presentedDigest, digest(token));
    matched = equal || matched;
  }
  return matched;
}
