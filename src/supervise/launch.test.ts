import { describe, expect, it } from "vitest";

import { supervisesLaunch } from "./launch";

describe("supervisesLaunch", () => {
  it("supervises a session launch on a pool that resumes on a spent quota", () => {
    expect(supervisesLaunch({ resumeOnLimit: true }, [])).toBe(true);
    expect(supervisesLaunch({ resumeOnLimit: true }, ["--continue"])).toBe(true);
  });

  it("leaves a launch on a pool that does not resume on a spent quota alone", () => {
    expect(supervisesLaunch({ resumeOnLimit: false }, [])).toBe(false);
    expect(supervisesLaunch({}, [])).toBe(false);
    expect(supervisesLaunch(undefined, [])).toBe(false);
  });

  it("leaves a claude subcommand alone, as it starts no conversation to move and rejects the supervisor's --session-id", () => {
    expect(supervisesLaunch({ resumeOnLimit: true }, ["plugin", "install", "miro@claude-plugins-official"])).toBe(false);
    expect(supervisesLaunch({ resumeOnLimit: true }, ["auth", "status"])).toBe(false);
  });
});
