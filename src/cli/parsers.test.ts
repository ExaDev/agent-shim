import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";

import { EXIT_USAGE } from "../cliError";
import { collectBoolPair, collectRepeated, collectStringPair, parseBool, parseBoolPairList, parsePair } from "./parsers";
import { InvalidEnvBoolError, parseEnvBool } from "./envBool";

describe("parsePair", () => {
  it("splits a simple key=value", () => {
    expect(parsePair("history=true")).toEqual({ key: "history", value: "true" });
  });

  it("splits only on the first =, leaving further = characters in the value", () => {
    expect(parsePair("knowledge/skills/foo=bar=baz")).toEqual({
      key: "knowledge/skills/foo",
      value: "bar=baz",
    });
  });

  it("allows an empty value", () => {
    expect(parsePair("history=")).toEqual({ key: "history", value: "" });
  });

  it("throws when there is no = at all", () => {
    expect(() => parsePair("history")).toThrow(/no "=" found/);
  });

  it("throws when the key half is empty", () => {
    expect(() => parsePair("=true")).toThrow(/non-empty key/);
  });

  it("throws for a completely empty string", () => {
    expect(() => parsePair("")).toThrow(/no "=" found/);
  });
});

describe("parseBool", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("parses %j as %j", (input, expected) => {
    expect(parseBool(input)).toBe(expected);
  });

  it.each(["True", "FALSE", "yes", "no", "", " true", "true ", "2"])(
    "rejects %j: no case-insensitivity, coercion, or whitespace tolerance",
    (input) => {
      expect(() => parseBool(input)).toThrow(/Expected "true", "false", "1" or "0"/);
    },
  );
});

describe("parseEnvBool", () => {
  it("reads unset and empty as not given", () => {
    expect(parseEnvBool("AGENT_SHIM_HEADROOM", undefined)).toBeUndefined();
    expect(parseEnvBool("AGENT_SHIM_HEADROOM", "")).toBeUndefined();
  });

  it("uses the same vocabulary as a flag value", () => {
    expect(parseEnvBool("AGENT_SHIM_HEADROOM", "true")).toBe(true);
    expect(parseEnvBool("AGENT_SHIM_HEADROOM", "1")).toBe(true);
    expect(parseEnvBool("AGENT_SHIM_HEADROOM", "false")).toBe(false);
    expect(parseEnvBool("AGENT_SHIM_HEADROOM", "0")).toBe(false);
  });

  it("raises a usage error naming the variable for anything else, rather than reading it as false", () => {
    expect(() => parseEnvBool("AGENT_SHIM_HEADROOM", "yes")).toThrow(InvalidEnvBoolError);
    expect(() => parseEnvBool("AGENT_SHIM_HEADROOM", "yes")).toThrow(/AGENT_SHIM_HEADROOM/);
    try {
      parseEnvBool("AGENT_SHIM_HEADROOM", "on");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvBoolError);
      expect(error instanceof InvalidEnvBoolError ? error.exitCode : undefined).toBe(EXIT_USAGE);
    }
  });
});

describe("parseBoolPairList", () => {
  it("parses a multi-entry list", () => {
    expect(parseBoolPairList("history=true,knowledge=false")).toEqual({
      history: true,
      knowledge: false,
    });
  });

  it("parses a single-entry list", () => {
    expect(parseBoolPairList("history=true")).toEqual({ history: true });
  });

  it("parses an empty string to an empty object", () => {
    expect(parseBoolPairList("")).toEqual({});
  });

  it("lets a later duplicate key in the same list win", () => {
    expect(parseBoolPairList("history=true,history=false")).toEqual({ history: false });
  });

  it("throws when any single pair in the list is malformed", () => {
    expect(() => parseBoolPairList("history=true,knowledge")).toThrow(/no "=" found/);
  });

  it("throws when any single pair's value is not a boolean", () => {
    expect(() => parseBoolPairList("history=yes")).toThrow(/Expected "true", "false", "1" or "0"/);
  });

  it("parses a path-shaped entry key", () => {
    expect(parseBoolPairList("knowledge/skills/commit=true")).toEqual({
      "knowledge/skills/commit": true,
    });
  });
});

describe("collectBoolPair", () => {
  it("starts from an empty object when no previous value is given", () => {
    expect(collectBoolPair("history=true")).toEqual({ history: true });
  });

  it("merges a new occurrence's pair over a previous accumulated object", () => {
    expect(collectBoolPair("knowledge=false", collectBoolPair("history=true"))).toEqual({ history: true, knowledge: false });
  });

  it("lets a later occurrence's key win over an earlier one", () => {
    expect(collectBoolPair("history=false", collectBoolPair("history=true"))).toEqual({ history: false });
  });

  it("never mutates the previous object it was given", () => {
    const first = collectBoolPair("history=true");
    const frozenCopy = { ...first };
    collectBoolPair("knowledge=false", first);
    expect(first).toEqual(frozenCopy);
  });

  it("takes one pair per occurrence: a comma is part of the value, not a list separator", () => {
    expect(() => collectBoolPair("history=true,knowledge=false")).toThrow(InvalidArgumentError);
  });

  it("raises Commander's InvalidArgumentError for a malformed pair, so Commander reports it as a usage error", () => {
    expect(() => collectBoolPair("history")).toThrow(InvalidArgumentError);
    expect(() => collectBoolPair("history=yes")).toThrow(InvalidArgumentError);
  });
});

describe("collectStringPair", () => {
  it("accumulates KEY=VALUE pairs, keeping further = signs in the value", () => {
    expect(collectStringPair("B=x=y", collectStringPair("A=1"))).toEqual({ A: "1", B: "x=y" });
  });

  it("raises InvalidArgumentError for a value with no =", () => {
    expect(() => collectStringPair("NOEQUALS")).toThrow(InvalidArgumentError);
  });
});

describe("collectRepeated", () => {
  it("keeps every occurrence in order", () => {
    expect(collectRepeated("b", collectRepeated("a"))).toEqual(["a", "b"]);
  });
});
