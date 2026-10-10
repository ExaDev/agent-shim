import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";

import type { LaunchResolution } from "../launcher";
import { LaunchRefusedError } from "../launchWiring";
import { createLaunchApiRouter, type LaunchApiDeps } from "./launchApi";
import { RC_ORPC_PATH_PREFIX, doorApiNodeHandlerOf } from "./rcApi";

/** The token the router under test accepts, standing in for the door's per-generation file-backed token. */
const CONTROL_TOKEN = "unit-launch-token";
/** A made-up value in the shape of an OAuth token: the answer must not be able to carry one, so a leak is findable without a real credential existing. */
const TOKEN_SHAPED = "sk-ant-REDACTED";
const WORK_DIRECTORY = "/home/testuser/work";

const RESOLUTION: LaunchResolution = {
  decision: {
    identity: "work",
    identitySource: "argv",
    pool: { name: "main", reasons: ["7d 60% used, resets in 1h"] },
    configDirEscapeHatch: false,
    configDir: "/home/testuser/.agent-shim/identities/work",
    configProfileSource: "none",
  },
  flags: { skipPermissions: false, remoteControl: false, headroom: true, trackUsage: false },
  claudeVersion: { version: "2.1.0", source: "flag" },
  bin: "/home/testuser/.local/share/claude/versions/2.1.0",
  args: ["--print"],
  credential: { subject: "identity", name: "work", summary: { target: "oauthToken", sources: [{ kind: "env", variable: "WORK_TOKEN" }] } },
  routing: { frontDoor: true, headroom: true },
  environment: ["ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY"],
};

type LaunchClient = RouterClient<ReturnType<typeof createLaunchApiRouter>>;

/** What the fake resolver was last asked, so a test can state what the procedure passed through. */
interface Asked {
  path?: string;
  argv?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

async function mountClient(deps: LaunchApiDeps, token: string): Promise<{ readonly client: LaunchClient; readonly close: () => Promise<void> }> {
  const surface = doorApiNodeHandlerOf(createLaunchApiRouter(deps), CONTROL_TOKEN);
  const server = http.createServer((request, response) => {
    void surface.handle(request, response).catch((error: unknown) => {
      console.error(error);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  return {
    client: createORPCClient(new RPCLink({ origin: `http://127.0.0.1:${String(address.port)}`, url: RC_ORPC_PATH_PREFIX, headers: { authorization: `Bearer ${token}` } })),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    },
  };
}

describe("the door's launch resolution API", () => {
  const asked: Asked = {};
  let behaviour: () => { resolution: LaunchResolution; warnings: readonly string[] } = () => ({ resolution: RESOLUTION, warnings: [] });
  const deps: LaunchApiDeps = {
    expectedToken: CONTROL_TOKEN,
    resolveLaunch: (request) => {
      asked.path = request.path;
      asked.argv = request.argv;
      asked.env = request.env;
      return behaviour();
    },
  };
  let client: LaunchClient;
  let refused: LaunchClient;
  const closes: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    const mounted = await mountClient(deps, CONTROL_TOKEN);
    client = mounted.client;
    closes.push(mounted.close);
    const refusedMount = await mountClient(deps, "not-the-control-token");
    refused = refusedMount.client;
    closes.push(refusedMount.close);
  });

  afterAll(async () => {
    for (const close of closes) {
      await close();
    }
  });

  it("answers the launcher's decision, its flags, its arguments and the credential by block, with the warnings the resolution raised", async () => {
    behaviour = () => ({ resolution: RESOLUTION, warnings: ["agent-shim: pool main names identity gone, which does not exist; skipping it"] });
    const answer = await client.launch.resolve({ path: WORK_DIRECTORY, argv: ["@pool:main", "--print"], env: { AGENT_SHIM_HEADROOM: "1" } });
    expect(answer).toEqual({ ...RESOLUTION, warnings: ["agent-shim: pool main names identity gone, which does not exist; skipping it"] });
    expect(asked).toEqual({ path: WORK_DIRECTORY, argv: ["@pool:main", "--print"], env: { AGENT_SHIM_HEADROOM: "1" } });
  });

  it("resolves a bare launch with no arguments and an empty environment, never the door's own", async () => {
    behaviour = () => ({ resolution: RESOLUTION, warnings: [] });
    await client.launch.resolve({ path: WORK_DIRECTORY });
    expect(asked).toEqual({ path: WORK_DIRECTORY, argv: [], env: {} });
  });

  it("refuses a relative path, since the door has no working directory of the caller's", async () => {
    await expect(client.launch.resolve({ path: "work" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answers a launch the launcher refuses with the launcher's own message, as a bad request", async () => {
    behaviour = () => {
      throw new LaunchRefusedError('agent-shim: no identity named "nobody" (selected via argv). Run `agent-shim identity add nobody` first.', 1);
    };
    await expect(client.launch.resolve({ path: WORK_DIRECTORY, argv: ["@nobody"] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining('no identity named "nobody"') as unknown });
  });

  it("does not turn an unexpected failure into a refusal", async () => {
    behaviour = () => {
      throw new Error("a bug, not a refused launch");
    };
    await expect(client.launch.resolve({ path: WORK_DIRECTORY })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("cannot carry a token: a value outside the closed answer shape fails the door's own output validation", async () => {
    // Built outside the return so the extra field is a runtime fact the procedure's output validation must catch, not a type error the compiler would catch first.
    const leaking = { ...RESOLUTION, leaked: TOKEN_SHAPED };
    behaviour = () => ({ resolution: leaking, warnings: [] });
    const failure: unknown = await client.launch.resolve({ path: WORK_DIRECTORY }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(JSON.stringify(failure)).not.toContain(TOKEN_SHAPED);
  });

  it("demands the control token", async () => {
    await expect(refused.launch.resolve({ path: WORK_DIRECTORY })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
