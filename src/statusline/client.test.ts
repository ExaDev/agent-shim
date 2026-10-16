import { describe, expect, it } from "vitest";

import { antigravityStacksWithDefault, isAntigravityPayload } from "./client";

const HOME = "/home/ada";
const SETTINGS_FILE = "/home/ada/.gemini/antigravity-cli/settings.json";

function fsWith(contents: string | undefined): { readFileUtf8: (file: string) => string | undefined } {
  return { readFileUtf8: (file) => (file === SETTINGS_FILE ? contents : undefined) };
}

describe("isAntigravityPayload", () => {
  it("recognises the payload the Antigravity CLI sends by its product field", () => {
    expect(isAntigravityPayload({ product: "antigravity" })).toBe(true);
    expect(isAntigravityPayload({ product: "claude-code" })).toBe(false);
    expect(isAntigravityPayload({})).toBe(false);
    expect(isAntigravityPayload(undefined)).toBe(false);
  });
});

describe("antigravityStacksWithDefault", () => {
  it("reads stack_with_default from the CLI's statusLine setting", () => {
    expect(antigravityStacksWithDefault(fsWith('{"statusLine":{"type":"command","stack_with_default":true}}'), HOME)).toBe(true);
    expect(antigravityStacksWithDefault(fsWith('{"statusLine":{"type":"command","stack_with_default":false}}'), HOME)).toBe(false);
  });

  it("answers false, the CLI's own default of replacing its line, when the file or the setting is absent", () => {
    expect(antigravityStacksWithDefault(fsWith(undefined), HOME)).toBe(false);
    expect(antigravityStacksWithDefault(fsWith("{}"), HOME)).toBe(false);
    expect(antigravityStacksWithDefault(fsWith('{"statusLine":{"type":"command"}}'), HOME)).toBe(false);
  });

  it("throws on a settings file that is not valid JSON rather than guessing", () => {
    expect(() => antigravityStacksWithDefault(fsWith("{not json"), HOME)).toThrow(SyntaxError);
  });
});
