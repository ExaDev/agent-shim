import { describe, expect, it } from "vitest";

import { declaredLength, withoutContentLength } from "./contentLength";

const DECLARED = 12;

describe("the declared body length in a request's headers", () => {
  it.each([
    [{ "content-length": "12" }, DECLARED],
    [{ "Content-Length": "12" }, DECLARED],
    [{ "CONTENT-LENGTH": "12" }, DECLARED],
    [{ "content-length": "twelve" }, Number.NaN],
    [{ "content-type": "application/json" }, Number.NaN],
    [{}, Number.NaN],
  ])("%j declares %s", (headers, length) => {
    expect(declaredLength(headers)).toBe(length);
  });

  it("is dropped, in whatever case, with every other header kept", () => {
    expect(withoutContentLength({ "Content-Length": "3", "x-a": "1", "content-length": "4" })).toEqual({ "x-a": "1" });
  });
});
