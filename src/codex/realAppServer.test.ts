import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexAppServerUnavailableError, readCodexAccount, readCodexRateLimits } from "./appServer";
import { realCodexAppServerPort } from "./realAppServer";

/** A stand-in `codex`: speaks the app-server's line protocol on stdio, reports the `CODEX_HOME` it was started with in the account's email, and exits when its input ends. */
const FAKE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  send({ method: "remoteControl/status/changed", params: { status: "disabled" } });
  process.stdout.write("not json, a log line\\n");
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "agent-shim/9.9.9 (test)" } });
  else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt", email: process.env.CODEX_HOME, planType: "pro" }, requiresOpenaiAuth: true } });
  else send({ id: message.id, error: { code: -32600, message: "codex account authentication required to read rate limits" } });
});
`;

let directory: string;
let fakeCodex: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-codex-app-server-"));
  fakeCodex = path.join(directory, "codex");
  fs.writeFileSync(fakeCodex, FAKE_CODEX, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("the real app-server port", () => {
  it("starts the executable with CODEX_HOME set for it alone and reads the account over stdio", async () => {
    const before = process.env.CODEX_HOME;

    const account = await readCodexAccount(realCodexAppServerPort, { codexHome: "/some/codex/home", bin: fakeCodex });

    expect(account).toEqual({ account: { type: "chatgpt", email: "/some/codex/home", planType: "pro" }, requiresOpenaiAuth: true });
    expect(process.env.CODEX_HOME).toBe(before);
  });

  it("reports a refusal from the process as the server's own error", async () => {
    const failure = await readCodexRateLimits(realCodexAppServerPort, { codexHome: directory, bin: fakeCodex }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ method: "account/rateLimits/read", rpcCode: -32_600 });
  });

  it("reports an executable that does not exist as unavailable", async () => {
    const failure = await readCodexAccount(realCodexAppServerPort, { codexHome: directory, bin: path.join(directory, "missing") }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CodexAppServerUnavailableError);
  });
});
