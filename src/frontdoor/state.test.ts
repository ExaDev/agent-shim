import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { listFrontDoorSessions, liveSessionTokens, pruneDeadFrontDoorSessions, removeFrontDoorSession, writeFrontDoorSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");

const LIVE = 301;
const DEAD = 302;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
/** A recognisable capability, so an assertion can search every serialised output for it. */
const SECRET_CAPABILITY = "capability-that-must-never-be-listed";

describe("front-door session registry", () => {
  it("lists a registered launch even though its record carries a capability token", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 7, token: SECRET_CAPABILITY });
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([{ pid: LIVE, startedAt: 7 }]);
  });

  it("never returns the token from a listing, so nothing that prints a session can leak the capability", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 7, token: SECRET_CAPABILITY });
    expect(JSON.stringify(listFrontDoorSessions(fs, paths.frontdoorSessionsDir))).not.toContain(SECRET_CAPABILITY);
    expect(liveSessionTokens(fs, paths.frontdoorSessionsDir).has(SECRET_CAPABILITY)).toBe(true);
  });

  it("skips malformed and token-less records instead of counting them as launches", () => {
    const fs = createFakeFarmFs({
      [`${paths.frontdoorSessionsDir}/1.json`]: "not json",
      [`${paths.frontdoorSessionsDir}/2.json`]: JSON.stringify({ pid: 2, startedAt: 0 }),
      [`${paths.frontdoorSessionsDir}/notes.txt`]: "ignored",
    });
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([]);
  });

  it("prunes a dead launch's record, and with it the capability it held, and keeps the live one", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "live-token" });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEAD, startedAt: 0, token: "dead-token" });
    expect(pruneDeadFrontDoorSessions(fs, paths.frontdoorSessionsDir, (pid) => pid === LIVE)).toEqual([DEAD]);
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir).map((session) => session.pid)).toEqual([LIVE]);
    expect([...liveSessionTokens(fs, paths.frontdoorSessionsDir)]).toEqual(["live-token"]);
  });

  it("removes one launcher's record idempotently", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "t" });
    removeFrontDoorSession(fs, paths.frontdoorSessionsDir, LIVE);
    removeFrontDoorSession(fs, paths.frontdoorSessionsDir, LIVE);
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([]);
  });

  it("writes the registry directory owner-only and each capability record owner-only", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "t" });
    expect(fs.modeOf(paths.frontdoorSessionsDir)).toBe(OWNER_ONLY_DIR);
    expect(fs.modeOf(`${paths.frontdoorSessionsDir}/${String(LIVE)}.json`)).toBe(OWNER_ONLY_FILE);
  });
});
