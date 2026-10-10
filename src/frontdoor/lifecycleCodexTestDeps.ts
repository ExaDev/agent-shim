import type { CodexStatus } from "../codex/commands";

/** The door's pid the lifecycle fakes report, a value no test process shares. */
const FAKE_DOOR_PID = 424_242;

/** Fakes for the lifecycle and Codex dependencies of the door's typed API, for suites that mount the whole door and exercise other procedures: nothing here restarts a process, reaches the network or touches a sign-in file. */
export const LIFECYCLE_AND_CODEX_TEST_DEPS = {
  doorPid: FAKE_DOOR_PID,
  restartDoor: (): void => undefined,
  checkForUpdate: async () => await Promise.resolve({ current: "0.0.0", latest: "0.0.0", action: "current" as const }),
  codexStatus: (): CodexStatus => ({
    frontDoor: {},
    supervisorAlive: false,
    sessions: [],
    codexProviders: [],
    signIn: { state: "none" },
    usageSnapshotPath: "/unused/codex-usage.json",
    usageSnapshotExists: false,
    logPath: "/unused/frontdoor.log",
    logExists: false,
  }),
  codexLogout: async () => await Promise.resolve({ hadGrant: false, revoked: false }),
};
