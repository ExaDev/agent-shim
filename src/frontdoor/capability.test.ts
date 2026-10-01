import { describe, expect, it } from "vitest";

import { CONNECT_PROXY_USER, capabilityFromProxyAuthorization, connectProxyUrl, isLiveCapability } from "./capability";

/** A made-up token holding every character a URL's userinfo must percent-encode, so the round trip proves the encoding rather than passing on a token that never needed it. */
const AWKWARD_TOKEN = "a:b@c/d?e#f%g h";

/** A made-up CONNECT surface port for the URL round trip. */
const CONNECT_PORT = 4200;

/** What a proxy-aware client does with an `HTTPS_PROXY` URL: percent-decode its userinfo and send it as a Basic credential. */
function basicFrom(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  return `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
}

describe("launch capability as a proxy credential", () => {
  it("puts the capability in the proxy URL so a client's Basic credential carries exactly the token back, whatever characters it holds", () => {
    const url = connectProxyUrl(CONNECT_PORT, AWKWARD_TOKEN);
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port).toBe(String(CONNECT_PORT));
    expect(decodeURIComponent(parsed.username)).toBe(CONNECT_PROXY_USER);
    expect(capabilityFromProxyAuthorization(basicFrom(url))).toBe(AWKWARD_TOKEN);
  });

  it("reads the password half of a Basic credential, scheme case-insensitively, keeping colons in the password", () => {
    const encode = (userPass: string): string => Buffer.from(userPass).toString("base64");
    expect(capabilityFromProxyAuthorization(`basic ${encode("anyone:tok")}`)).toBe("tok");
    expect(capabilityFromProxyAuthorization(` BASIC   ${encode("u:with:colons")} `)).toBe("with:colons");
  });

  it("presents no capability for another scheme, a credential with no password, or no credential at all", () => {
    const encode = (userPass: string): string => Buffer.from(userPass).toString("base64");
    expect(capabilityFromProxyAuthorization("Bearer tok")).toBeUndefined();
    expect(capabilityFromProxyAuthorization(`Basic ${encode("no-colon")}`)).toBeUndefined();
    expect(capabilityFromProxyAuthorization(`Basic ${encode("user:")}`)).toBeUndefined();
    expect(capabilityFromProxyAuthorization("Basic")).toBeUndefined();
    expect(capabilityFromProxyAuthorization("")).toBeUndefined();
  });

  it("accepts exactly a live token, refusing near misses and anything when no launch is live", () => {
    const live = ["first-live-token", "second-live-token"];
    expect(isLiveCapability("second-live-token", live)).toBe(true);
    expect(isLiveCapability("first-live-token", live)).toBe(true);
    expect(isLiveCapability("second-live-toke", live)).toBe(false);
    expect(isLiveCapability("second-live-tokenX", live)).toBe(false);
    expect(isLiveCapability("", live)).toBe(false);
    expect(isLiveCapability("first-live-token", [])).toBe(false);
  });
});
