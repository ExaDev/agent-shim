import type { CodexStatus } from "../codex/commands";
import { realFarmFs } from "../realPorts";
import { TEST_CLAUDE_LOGIN } from "../keychainTestWorld";

/** The door's pid the lifecycle fakes report, a value no test process shares. */
const FAKE_DOOR_PID = 424_242;

/** Fakes for the lifecycle and Codex dependencies of the door's typed API, for suites that mount the whole door and exercise other procedures: nothing here restarts a process, reaches the network, touches a sign-in file or asks a Keychain. */
export const LIFECYCLE_AND_CODEX_TEST_DEPS = {
  doorPid: FAKE_DOOR_PID,
  restartDoor: (): void => undefined,
  refreshCatalogues: (): void => undefined,
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
  // A platform without a Keychain, so the identity add procedure never asks, and a runner that fails the suite if it is asked anyway.
  keychain: {
    platform: "linux" as const,
    runAsync: async (): Promise<never> => await Promise.reject(new Error("this suite mounts a door that has no Keychain to ask")),
  },
  // The file reads and the login derivation identity removal makes; a fixed user, so nothing reads the real environment.
  fs: realFarmFs,
  claudeLogin: TEST_CLAUDE_LOGIN,
};
