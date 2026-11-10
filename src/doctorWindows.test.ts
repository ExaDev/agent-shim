import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { collectDoctorReport } from "./doctorReport";
import { buildLayoutPaths } from "./paths";

describe("collectDoctorReport on a platform with no POSIX user id", () => {
  /** Runs `body` as `win32` does: no `process.getuid`, and `process.platform` saying so. */
  function asWindows<T>(body: () => T): T {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      return body();
    } finally {
      if (platform !== undefined) {
        Object.defineProperty(process, "platform", platform);
      }
      if (getuid !== undefined) {
        Object.defineProperty(process, "getuid", getuid);
      }
    }
  }

  it("reports without asking for a user id, whatever the allowlist or the headroom state holds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-windows-root-"));
    try {
      fs.mkdirSync(path.join(root, "headroom"), { recursive: true });
      fs.writeFileSync(path.join(root, "headroom", "allowlist.txt"), "example.com\n");
      const report = asWindows(() => collectDoctorReport({ paths: buildLayoutPaths(root), env: { PATH: process.env.PATH ?? "" } }));
      expect(report.findings.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
