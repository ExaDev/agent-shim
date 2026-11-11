import { describe, expect, it } from "vitest";

import { MAX_LOGGED_TEXT_CHARS } from "./loggedText";
import { encodedRequestMessage, isEncoded } from "./requestEncoding";

describe("which headers say a body is encoded", () => {
  it.each([
    [{ "content-encoding": "gzip" }, true],
    [{ "Content-Encoding": " ZSTD " }, true],
    [{ "content-encoding": ["identity", "br"] }, true],
    [{ "content-encoding": "identity, br" }, true],
    [{ "content-encoding": "identity, Identity" }, false],
    [{ "content-encoding": "identity" }, false],
    [{ "content-encoding": " Identity " }, false],
    [{ "content-encoding": "" }, false],
    [{ "content-encoding": [] }, false],
    [{ "content-encoding": undefined }, false],
    [{ "content-type": "application/json" }, false],
  ])("%j is %s", (headers, encoded) => {
    expect(isEncoded(headers)).toBe(encoded);
  });
});

describe("the refusal of an encoded request", () => {
  it("names the provider and every coding, and is absent for an unencoded body", () => {
    expect(encodedRequestMessage({ "content-encoding": ["gzip", "br"] }, "spark")).toBe('provider "spark": the request body is encoded (Content-Encoding: "gzip", "br"), and the model it names cannot be read from an encoded body; send it unencoded');
    expect(encodedRequestMessage({ "content-encoding": "gzip" })).toMatch(/^the request body is encoded/);
    const benign = encodedRequestMessage({ "content-encoding": "x" }) ?? "";
    const long = encodedRequestMessage({ "content-encoding": "y".repeat(MAX_LOGGED_TEXT_CHARS * 2) }) ?? "";
    expect(long.length).toBeLessThanOrEqual(benign.length + MAX_LOGGED_TEXT_CHARS);
    expect(encodedRequestMessage({ "content-encoding": "x\ny" })).not.toContain("\n");
    expect(encodedRequestMessage({ "Content-Encoding": "gzip" }, "spark")).toBe('provider "spark": the request body is encoded (Content-Encoding: "gzip"), and the model it names cannot be read from an encoded body; send it unencoded');
    expect(encodedRequestMessage({ "CONTENT-ENCODING": "identity, br" })).toContain('"br"');
    expect(encodedRequestMessage({ "content-encoding": ["gzip", " zstd "] })).toContain('"gzip", "zstd"');
    expect(encodedRequestMessage({}, "spark")).toBeUndefined();
  });
});
