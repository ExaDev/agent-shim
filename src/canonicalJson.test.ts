import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonicalJson";

describe("canonicalJson", () => {
  it("gives the same text for objects holding the same data in any key order, at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }));
  });

  it("keeps the order of an array, since it is data", () => {
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
  });

  it("tells apart values that differ in a member, and leaves out an undefined one as JSON does", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("writes scalars as JSON does", () => {
    expect([canonicalJson("x"), canonicalJson(1), canonicalJson(null)]).toEqual(['"x"', "1", "null"]);
  });
});
