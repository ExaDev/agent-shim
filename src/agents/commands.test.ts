import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { formatSessionList, formatSessionTree } from "./commands";
import { readSessionAgentTree } from "./read";
import type { SessionCommandFs } from "./realFs";
import { collectSessionList, locateSession, SessionLookupError } from "./sessions";

const IDENTITIES = "/state/identities";
const WORK = `${IDENTITIES}/work`;
const PERSONAL = `${IDENTITIES}/personal`;
const PROJECT = "-repo";

/**
 * A fake filesystem with `realpath`: a path resolves to itself when present, or to the target `sharedStores` maps its prefix to, which is how two identities are made to share one history store.
 */
function withRealpath(seed: Readonly<Record<string, string>>, sharedStores: Readonly<Record<string, string>> = {}): SessionCommandFs {
  const fs = createFakeFarmFs(seed);
  return {
    ...fs,
    realpath: (candidate) => {
      const shared = sharedStores[candidate];
      if (shared !== undefined) {
        return shared;
      }
      return fs.lstat(candidate) === undefined ? undefined : candidate;
    },
  };
}

function seedSession(configDir: string, sessionId: string, agents: readonly string[], extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const seeded: Record<string, string> = { [`${configDir}/projects/${PROJECT}/${sessionId}.jsonl`]: "" };
  for (const id of agents) {
    seeded[`${configDir}/projects/${PROJECT}/${sessionId}/subagents/agent-${id}.meta.json`] = JSON.stringify({ agentType: "Explore", spawnDepth: 1, description: `task ${id}` });
  }
  return { ...seeded, ...extra };
}

describe("collectSessionList", () => {
  const fs = withRealpath({
    ...seedSession(WORK, "aaaa1111", ["x", "y"]),
    ...seedSession(WORK, "bbbb2222", []),
    ...seedSession(PERSONAL, "cccc3333", ["z"]),
    [`${WORK}/projects/${PROJECT}/dddd4444/workflows/wf_run.json`]: "{}",
  });

  it("lists sessions that have agents or workflow runs across identities, and counts them", () => {
    const sessions = collectSessionList(fs, IDENTITIES, ["work", "personal"], {});
    expect(sessions.map((session) => `${session.identities.join("+")}/${session.sessionId}:${String(session.agentCount)}:${String(session.workflowRunCount)}`).sort()).toEqual([
      "personal/cccc3333:1:0",
      "work/aaaa1111:2:0",
      "work/dddd4444:0:1",
    ]);
  });

  it("includes sessions with nothing to inspect when asked, and narrows to one identity", () => {
    expect(collectSessionList(fs, IDENTITIES, ["work", "personal"], { all: true, identity: "work" }).map((session) => session.sessionId).sort()).toEqual(["aaaa1111", "bbbb2222", "dddd4444"]);
  });

  it("fails for an identity that does not exist rather than listing nothing", () => {
    expect(() => collectSessionList(fs, IDENTITIES, ["work"], { identity: "nope" })).toThrow(SessionLookupError);
  });

  it("orders newest transcript first", () => {
    const ordered = withRealpath({
      ...seedSession(WORK, "older", ["a"]),
      ...seedSession(WORK, "newer", ["a"]),
    });
    // The fake filesystem stamps entries in creation order, so the later seed has the later mtime.
    expect(collectSessionList(ordered, IDENTITIES, ["work"], {}).map((session) => session.sessionId)).toEqual(["newer", "older"]);
  });
});

describe("shared history", () => {
  it("lists a session once, naming every identity whose projects directory is the same store", () => {
    const fs = withRealpath(seedSession(WORK, "aaaa1111", ["x"]), { [`${WORK}/projects`]: "/store/projects", [`${PERSONAL}/projects`]: "/store/projects" });
    const sessions = collectSessionList(fs, IDENTITIES, ["work", "personal"], {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.identities).toEqual(["work", "personal"]);
  });

  it("skips an identity that has no projects directory", () => {
    const fs = withRealpath(seedSession(WORK, "aaaa1111", ["x"]));
    expect(collectSessionList(fs, IDENTITIES, ["work", "never-ran"], {}).map((session) => session.identities)).toEqual([["work"]]);
  });
});

describe("locateSession", () => {
  const fs = withRealpath({ ...seedSession(WORK, "abcd1111", ["a"]), ...seedSession(PERSONAL, "abef2222", ["b"]) });

  it("resolves an exact id and an unambiguous prefix", () => {
    expect(locateSession(fs, IDENTITIES, ["work", "personal"], "abcd1111").identities).toEqual(["work"]);
    expect(locateSession(fs, IDENTITIES, ["work", "personal"], "abcd").ref.sessionId).toBe("abcd1111");
  });

  it("names every candidate when a prefix is ambiguous, and fails when nothing matches", () => {
    expect(() => locateSession(fs, IDENTITIES, ["work", "personal"], "ab")).toThrow(/abcd1111 \(work\); abef2222 \(personal\)/);
    expect(() => locateSession(fs, IDENTITIES, ["work", "personal"], "zz")).toThrow(/no session matches/);
  });

  it("narrows to the identity asked for", () => {
    expect(locateSession(fs, IDENTITIES, ["work", "personal"], "ab", "personal").ref.sessionId).toBe("abef2222");
  });
});

describe("formatting", () => {
  it("prints a placeholder for an empty list and one line per session otherwise", () => {
    expect(formatSessionList([])).toEqual(["no sessions with agents or workflow runs found"]);
    const fs = withRealpath(seedSession(WORK, "aaaa1111", ["x"]));
    const [line] = formatSessionList(collectSessionList(fs, IDENTITIES, ["work"], {}));
    expect(line).toMatch(/^work {2}aaaa1111 {2}\S+ {2}agents=1 runs=0 {2}-repo$/);
  });

  it("abbreviates the identities of a session several of them expose", () => {
    const fs = withRealpath(seedSession(WORK, "aaaa1111", ["x"]), { [`${WORK}/projects`]: "/store/projects", [`${PERSONAL}/projects`]: "/store/projects" });
    const [line] = formatSessionList(collectSessionList(fs, IDENTITIES, ["work", "personal"], {}));
    expect(line?.startsWith("work +1  aaaa1111")).toBe(true);
  });

  it("indents children under their parent and lists tasks and problems", () => {
    const fs = createFakeFarmFs({
      [`${WORK}/projects/${PROJECT}/s/subagents/agent-p.meta.json`]: JSON.stringify({ agentType: "Plan", spawnDepth: 1, requestShape: "background" }),
      [`${WORK}/projects/${PROJECT}/s/subagents/agent-c.meta.json`]: JSON.stringify({ agentType: "fork", isFork: true, spawnDepth: 2, parentAgentId: "p", description: "tidy" }),
      [`${WORK}/projects/${PROJECT}/s/subagents/agent-bad.meta.json`]: "nope",
      [`${WORK}/tasks/s/1.json`]: JSON.stringify({ id: "1", subject: "do it", status: "pending" }),
    });
    const tree = readSessionAgentTree(fs, WORK, { project: PROJECT, sessionId: "s", superseded: false, entry: "s" });
    const lines = formatSessionTree(["work"], tree);
    expect(lines[0]).toBe(`session s  identities work  project ${PROJECT}`);
    expect(lines).toContain("  - [subagent] Plan p  (background)");
    expect(lines).toContain("    - [fork] fork c  tidy");
    expect(lines).toContain("  [pending] 1  do it");
    expect(lines.some((line) => line.includes("agent-bad.meta.json"))).toBe(true);
  });
});
