import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatDoctorReport } from "./doctorFormat";
import { collectDoctorReport, runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";
import { buildLayoutPaths } from "./paths";

const STALE_SESSIONS = { rel: "sessions", target: "/home/u/.claude/sessions" } as const;

describe("runDoctor: farm-links", () => {
  it("passes once when no identity's farm has a link that leads nowhere", () => {
    const report = runDoctor(baseParams({ identities: [identity("work")], farmLinks: [{ name: "work", id: "work", dangling: [] }] }));
    expect(findingsFor(report, "farm-links")).toEqual([{ section: "farm-links", severity: "pass", message: "Every identity's farm links lead somewhere." }]);
    expect(report.ok).toBe(true);
  });

  it("warns of each farm link that leads nowhere, naming the identity, the entry, its target, what it breaks and the command that brings the farm up to date", () => {
    const report = runDoctor(baseParams({ identities: [identity("work"), identity("home", { id: "id-2" })], farmLinks: [{ name: "work", id: "work", dangling: [STALE_SESSIONS] }, { name: "home", id: "id-2", dangling: [{ rel: "agents" }] }] }));

    expect(findingsFor(report, "farm-links")).toEqual([
      {
        section: "farm-links",
        severity: "warn",
        subject: "work",
        message:
          "identities/work/sessions is a farm link to /home/u/.claude/sessions that leads nowhere, so Claude Code cannot write through it (an interactive session's record under sessions/ is lost, so the session is missing from `claude agents`). " +
          "A launch through agent-shim resyncs the farm and leaves the link out, but a session started with this directory as CLAUDE_CONFIG_DIR does not. Run `agent-shim identity resync work` in the directory those sessions start in to bring the farm up to date without launching.",
      },
      {
        section: "farm-links",
        severity: "warn",
        subject: "home",
        message:
          "identities/id-2/agents is a farm link that leads nowhere, so Claude Code cannot write through it. " +
          "A launch through agent-shim resyncs the farm and leaves the link out, but a session started with this directory as CLAUDE_CONFIG_DIR does not. Run `agent-shim identity resync home` in the directory those sessions start in to bring the farm up to date without launching.",
      },
    ]);
    // A warning: the next resync repairs it, so it does not fail the audit.
    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain("Farm links:");
  });

  it("names the Codex launch for a Codex identity, which `identity resync` refuses", () => {
    const codex = identity("cx", { raw: JSON.stringify({ name: "cx", allowAmbientCredential: false, agent: "codex" }) });
    const report = runDoctor(baseParams({ identities: [codex], farmLinks: [{ name: "cx", id: "cx", dangling: [{ rel: "skills" }] }] }));
    expect(findingsFor(report, "farm-links").map((finding) => finding.message)).toEqual([
      "identities/cx/skills is a farm link that leads nowhere, so Codex cannot write through it. A launch with `agent-shim run --agent codex @cx` resyncs the farm and leaves the link out.",
    ]);
  });

  it("leaves the section out when no farm links are given", () => {
    expect(findingsFor(runDoctor(baseParams({ identities: [identity("work")] })), "farm-links")).toEqual([]);
  });
});

describe("collectDoctorReport: farm links", () => {
  // Real-wired: the collector reads each identity's farm through realFarmFs, which follows a symlink to its end as `stat` does.
  it.skipIf(process.platform === "win32")("warns of a farm link on disk whose target is gone, and of nothing that leads somewhere", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-farm-links-"));
    try {
      const farm = path.join(root, "identities", "work");
      fs.mkdirSync(farm, { recursive: true });
      fs.writeFileSync(path.join(farm, "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
      fs.mkdirSync(path.join(root, "shared-skills"));
      fs.symlinkSync(path.join(root, "shared-skills"), path.join(farm, "skills"));
      fs.symlinkSync(path.join(root, "gone-sessions"), path.join(farm, "sessions"));

      const findings = findingsFor(collectDoctorReport({ paths: buildLayoutPaths(root), env: {} }), "farm-links");

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: "warn", subject: "work" });
      expect(findings[0]?.message).toMatch(/^identities\/work\/sessions is a farm link that leads nowhere, /);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
