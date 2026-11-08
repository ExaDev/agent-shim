import { describe, expect, it } from "vitest";

import { displayBaseUrl, redactUrlIn } from "./baseUrlDisplay";

describe("displayBaseUrl", () => {
  it("drops userinfo, query and fragment", () => {
    expect(displayBaseUrl("https://user:token@host:8443/api/v1?key=k#frag")).toBe("https://host:8443/api/v1");
  });

  it("keeps a root slash only when it was written in the path", () => {
    expect(displayBaseUrl("https://host")).toBe("https://host");
    expect(displayBaseUrl("https://host/")).toBe("https://host/");
  });

  it("decides the root slash from the path, not from what follows it", () => {
    expect(displayBaseUrl("https://host?key=x")).toBe("https://host");
    expect(displayBaseUrl("https://host/?key=x")).toBe("https://host/");
    expect(displayBaseUrl("https://host/#frag")).toBe("https://host/");
    expect(displayBaseUrl("https://host#frag")).toBe("https://host");
  });
});

describe("redactUrlIn", () => {
  it("replaces the URL as written and as normalised, leaving the rest of the text", () => {
    const written = "https://user:pw@HOST/api?key=k";
    const text = `bad ${written} and ${new URL(written).href}`;
    expect(redactUrlIn(text, written)).toBe("bad https://host/api and https://host/api");
  });
});
