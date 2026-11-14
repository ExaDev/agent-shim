import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { COMPACT_INSTRUCTIONS, FIRST_CONDITION, LAB_CHECKS, PEER_CONDITION, SECOND_CONDITION, TURN_TEXT, binaryPackageName, compareReleaseVersions, documentWithVersions, formatReport, matchesIntegrity, newestVersion, parsePublishedVersions, parseRegistryTarball, pendingRequestIds, registryPackageUrl, registryVersionUrl, verifiedVersionsSource, versionsNewerThanVerified, withVersions } from "./verify-claude-code-core";

const sri = (bytes: Uint8Array): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

describe("the releases a scheduled run verifies", () => {
  it("are the plain release versions newer than the newest verified one, oldest first, compared part by part", () => {
    expect(versionsNewerThanVerified(["2.1.9", "2.1.10", "2.1.100", "2.1.11-beta.1", "2.2.0", "2.0.999", "2.1.8"], ["2.1.8", "2.1.9"])).toEqual(["2.1.10", "2.1.100", "2.2.0"]);
  });

  it("are none when the newest published release is verified", () => {
    expect(versionsNewerThanVerified(["2.1.1", "2.1.2"], ["2.1.2", "2.1.1"])).toEqual([]);
  });

  it("cannot be worked out from an empty verified list", () => {
    expect(() => versionsNewerThanVerified(["2.1.1"], [])).toThrow(/empty/);
  });

  it("start after the newest verified version, read numerically", () => {
    expect(newestVersion(["2.1.100", "2.1.99"])).toBe("2.1.100");
  });

  it("orders versions numerically rather than as text", () => {
    expect(["2.1.10", "2.1.9", "10.0.0", "2.1.100"].sort(compareReleaseVersions)).toEqual(["2.1.9", "2.1.10", "2.1.100", "10.0.0"]);
  });

  it("reads the version names from the registry's package document, and refuses one with none", () => {
    expect(parsePublishedVersions({ name: "x", versions: { "2.1.1": {}, "2.1.2": {} } })).toEqual(["2.1.1", "2.1.2"]);
    expect(() => parsePublishedVersions({ name: "x" })).toThrow(/no versions/);
  });
});

describe("a release's binary", () => {
  it("comes from the platform package the main package names as an optional dependency", () => {
    expect(binaryPackageName({ platform: "darwin", arch: "arm64", musl: false })).toBe("@anthropic-ai/claude-code-darwin-arm64");
    expect(binaryPackageName({ platform: "linux", arch: "x64", musl: true })).toBe("@anthropic-ai/claude-code-linux-x64-musl");
  });

  it("is looked up at the registry with the scope's slash encoded", () => {
    expect(registryVersionUrl("https://registry.example", "@scope/name-linux-x64", "1.2.3")).toBe("https://registry.example/@scope%2fname-linux-x64/1.2.3");
    expect(registryPackageUrl("https://registry.example", "@scope/name")).toBe("https://registry.example/@scope%2fname");
  });

  it("is read from the tarball the version document names, and a document without one is refused", () => {
    expect(parseRegistryTarball({ dist: { tarball: "https://registry.example/t.tgz", integrity: "sha512-x" } })).toEqual({ tarball: "https://registry.example/t.tgz", integrity: "sha512-x" });
    expect(() => parseRegistryTarball({ dist: { tarball: "https://registry.example/t.tgz" } })).toThrow(/no tarball and integrity/);
  });

  it("is accepted only when the tarball's sha512 is the one the registry publishes", () => {
    const bytes = new TextEncoder().encode("tarball");
    expect(matchesIntegrity(sri(bytes), bytes)).toBe(true);
    expect(matchesIntegrity(`sha1-abc ${sri(bytes)}`, bytes)).toBe(true);
    expect(matchesIntegrity(sri(new TextEncoder().encode("other")), bytes)).toBe(false);
    expect(matchesIntegrity("sha1-abc", bytes)).toBe(false);
  });
});

describe("recording verified versions", () => {
  const SOURCE = '/** doc */\nexport const RC_SESSION_COMMAND_VERIFIED_VERSIONS: readonly string[] = ["2.1.319", "2.1.325"];\n';
  const DOCUMENT = "# Title\n\n## Supported versions\n\nThe goal, compaction and turn verbs are verified on Claude Code 2.1.319 and 2.1.325 (`RC_SESSION_COMMAND_VERIFIED_VERSIONS`). More.\n";

  it("rewrites the gate's array literal and nothing else", () => {
    expect(verifiedVersionsSource(SOURCE, ["2.1.319", "2.1.325", "2.1.326"])).toBe('/** doc */\nexport const RC_SESSION_COMMAND_VERIFIED_VERSIONS: readonly string[] = ["2.1.319", "2.1.325", "2.1.326"];\n');
    expect(() => verifiedVersionsSource("export const OTHER = [];", ["1.0.0"])).toThrow(/array literal/);
  });

  it("names the versions in the document's supported versions sentence, in the form the gate's test reads", () => {
    expect(documentWithVersions(DOCUMENT, ["2.1.319", "2.1.325", "2.1.326"])).toBe(DOCUMENT.replace("2.1.319 and 2.1.325", "2.1.319, 2.1.325 and 2.1.326"));
    expect(documentWithVersions(DOCUMENT, ["2.1.319"])).toBe(DOCUMENT.replace("2.1.319 and 2.1.325", "2.1.319"));
    expect(() => documentWithVersions("# Title\n", ["1.0.0"])).toThrow(/supported versions/);
  });

  it("adds each version once and keeps the list in release order", () => {
    expect(withVersions(["2.1.325", "2.1.319"], ["2.1.326", "2.1.325", "2.1.400"])).toEqual(["2.1.319", "2.1.325", "2.1.326", "2.1.400"]);
  });
});

describe("the lab checks", () => {
  const byName = (name: string): NonNullable<(typeof LAB_CHECKS)[number]["expect"]> => {
    const judge = LAB_CHECKS.find((check) => check.name === name)?.expect;
    if (judge === undefined) {
      throw new Error(`no judged check named ${name}`);
    }
    return judge;
  };

  it("run the documented sequence: a turn, the goal read, set, read, replaced and cleared, both compactions, and a peer's /goal that sets nothing", () => {
    expect(LAB_CHECKS.map((check) => check.args)).toEqual([
      ["turn", "--text", TURN_TEXT],
      ["goal", "get"],
      ["goal", "set", "--condition", FIRST_CONDITION],
      ["goal", "get"],
      ["goal", "set", "--condition", SECOND_CONDITION],
      ["goal", "clear"],
      ["compact"],
      ["compact", "--instructions", COMPACT_INSTRUCTIONS],
      ["send", "--text", `/goal ${PEER_CONDITION}`],
      ["goal", "get"],
    ]);
  });

  it("pass the answers a verified version gives, on every route", () => {
    for (const route of ["launched", "supervised", "self-hosted"] as const) {
      const trigger = route === "self-hosted" ? "manual" : "plugin";
      expect(byName("turn")({ session: "s", route, uuid: "u-1" }, route)).toBeUndefined();
      expect(byName("goal get, none set")({ session: "s", route, goal: null }, route)).toBeUndefined();
      expect(byName("goal set")({ session: "s", route, condition: FIRST_CONDITION, superseded: null }, route)).toBeUndefined();
      expect(byName("goal get, set")({ session: "s", route, goal: { condition: FIRST_CONDITION, iterations: 0 } }, route)).toBeUndefined();
      expect(byName("goal set, replacing")({ session: "s", route, condition: SECOND_CONDITION, superseded: FIRST_CONDITION }, route)).toBeUndefined();
      expect(byName("goal clear")({ session: "s", route, cleared: SECOND_CONDITION }, route)).toBeUndefined();
      expect(byName("compact")({ session: "s", route, trigger, preTokens: 9, postTokens: 1 }, route)).toBeUndefined();
      expect(byName("goal get, after a peer's /goal")({ session: "s", route, goal: null }, route)).toBeUndefined();
    }
  });

  it("name what differs: another route, a missing uuid, a goal left set, a superseded goal not named, a compaction that was not manual on the self-hosted route", () => {
    expect(byName("turn")({ route: "self-hosted", uuid: "u" }, "launched")).toBe('route is "self-hosted", expected "launched"');
    expect(byName("turn")({ route: "launched" }, "launched")).toBe("uuid is undefined, expected the recorded user entry's");
    expect(byName("goal get, after a peer's /goal")({ route: "launched", goal: { condition: PEER_CONDITION, iterations: 0 } }, "launched")).toBe(`goal is ${JSON.stringify({ condition: PEER_CONDITION, iterations: 0 })}, expected none`);
    expect(byName("goal set, replacing")({ route: "launched", condition: SECOND_CONDITION, superseded: null }, "launched")).toBe(`superseded is null, expected ${JSON.stringify(FIRST_CONDITION)}`);
    expect(byName("compact")({ route: "self-hosted", trigger: "auto" }, "self-hosted")).toBe('trigger is "auto", expected "manual"');
    expect(byName("goal get, none set")("not json", "launched")).toBe('the answer is not an object: "not json"');
  });
});

describe("a pending list", () => {
  it("answers its request ids, and refuses an answer of another shape", () => {
    expect(pendingRequestIds({ pending: [{ sessionId: "s", requestId: "r1" }, { sessionId: "s", requestId: "r2" }] })).toEqual(["r1", "r2"]);
    expect(pendingRequestIds({ pending: [] })).toEqual([]);
    expect(() => pendingRequestIds({})).toThrow(/no pending list/);
    expect(() => pendingRequestIds({ pending: [{ sessionId: "s" }] })).toThrow(/no request id/);
  });
});

describe("the report", () => {
  it("names each differing check with what differed, and ends on the verdict", () => {
    expect(formatReport("9.9.9", [{ route: "launched", name: "turn" }, { route: "self-hosted", name: "compact", difference: 'trigger is "auto", expected "manual"' }])).toEqual([
      "pass    launched: turn",
      'DIFFERS self-hosted: compact: trigger is "auto", expected "manual"',
      "Claude Code 9.9.9: 1 of 2 checks differed",
    ]);
    expect(formatReport("9.9.9", [{ route: "launched", name: "turn" }]).at(-1)).toBe("Claude Code 9.9.9: every check passed");
  });
});
