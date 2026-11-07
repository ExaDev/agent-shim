import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { fakeLog } from "../test-helpers";
import { realWatchExistingDirectory } from "./realPorts";

const PERMISSION_MASK = 0o777;
const EXISTING_MODE = 0o755;

it("watches a transcript directory without changing its permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-watch-test-"));
  try {
    fs.chmodSync(directory, EXISTING_MODE);
    const stop = realWatchExistingDirectory(directory, () => true, "test", fakeLog())(() => undefined);
    try {
      expect(fs.statSync(directory).mode & PERMISSION_MASK).toBe(EXISTING_MODE);
    } finally {
      stop();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
