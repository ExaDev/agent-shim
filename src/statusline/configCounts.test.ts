import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { countConfiguration } from "./configCounts";
import { realStatuslinePorts } from "./ports";
import { fakeStatuslineFilesystem, fakeStatuslinePorts } from "./testing";

const HOME = "/home/test";
const PROJECT = "/work/app";
const CLAUDE_MD_FILES = 5;
const RULES_FILES = 3;
const MCP_SCOPES_TOTAL = 5;
const HOOK_EVENTS = 4;
const NOT_A_NAME = 7;
const UNDER_BOUND_MEBIBYTES = 7;
const OVER_BOUND_MEBIBYTES = 9;

interface Setup {
  readonly env?: Readonly<Record<string, string>>;
  readonly project?: string | undefined;
  readonly links?: Readonly<Record<string, string>>;
}

function counts(files: Readonly<Record<string, string>>, options: Setup = {}): ReturnType<typeof countConfiguration> {
  const ports = fakeStatuslinePorts({ ...fakeStatuslineFilesystem(files, options.links).ports, homeDirectory: HOME, env: options.env ?? {} });
  return countConfiguration(ports, "project" in options ? options.project : PROJECT);
}

/** Resolves once `server` listens on a socket at `socket`, which it creates there. */
async function listening(server: net.Server, socket: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
}

/** Resolves once `server` has stopped listening, whether or not it ever started. */
async function closed(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe("countConfiguration", () => {
  it("counts nothing in an empty configuration", () => {
    expect(counts({})).toEqual({ claudeMd: 0, rules: 0, mcpServers: 0, hookEvents: 0 });
  });

  it("counts the CLAUDE.md files of the user and of the project, in each of the places Claude Code reads", () => {
    const files = {
      [`${HOME}/.claude/CLAUDE.md`]: "",
      [`${PROJECT}/CLAUDE.md`]: "",
      [`${PROJECT}/CLAUDE.local.md`]: "",
      [`${PROJECT}/.claude/CLAUDE.md`]: "",
      [`${PROJECT}/.claude/CLAUDE.local.md`]: "",
    };
    expect(counts(files).claudeMd).toBe(CLAUDE_MD_FILES);
    expect(counts(files, { project: undefined }).claudeMd).toBe(1);
  });

  it("counts Markdown files under the rules directories at any depth, and nothing else", () => {
    const files = {
      [`${HOME}/.claude/rules/a.md`]: "",
      [`${HOME}/.claude/rules/nested/deeper/b.md`]: "",
      [`${HOME}/.claude/rules/notes.txt`]: "",
      [`${PROJECT}/.claude/rules/c.md`]: "",
    };
    expect(counts(files).rules).toBe(RULES_FILES);
  });

  it("counts a rules file once however many links reach it, and does not loop on a link back up the tree", () => {
    const files = { [`${HOME}/real/a.md`]: "", [`${HOME}/real/b.md`]: "" };
    const links = { [`${HOME}/.claude/rules`]: `${HOME}/real`, [`${HOME}/real/again`]: `${HOME}/real` };
    expect(counts(files, { links }).rules).toBe(2);
  });

  it("counts MCP servers of each scope, a server named in two scopes counting in both", () => {
    const files = {
      [`${HOME}/.claude/settings.json`]: JSON.stringify({ mcpServers: { a: {} } }),
      [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { a: {}, b: {} } }),
      [`${PROJECT}/.mcp.json`]: JSON.stringify({ mcpServers: { a: {}, c: {} } }),
      [`${PROJECT}/.claude/settings.local.json`]: JSON.stringify({ mcpServers: { d: {} } }),
    };
    expect(counts(files).mcpServers).toBe(MCP_SCOPES_TOTAL);
  });

  it("leaves out the servers the user and the project's local settings disable", () => {
    const files = {
      [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { a: {}, b: {} }, disabledMcpServers: ["b", NOT_A_NAME] }),
      [`${PROJECT}/.mcp.json`]: JSON.stringify({ mcpServers: { c: {}, d: {} } }),
      [`${PROJECT}/.claude/settings.local.json`]: JSON.stringify({ disabledMcpjsonServers: ["c"] }),
    };
    expect(counts(files).mcpServers).toBe(2);
  });

  it("counts the hook events of the settings files, not the commands under them", () => {
    const files = {
      [`${HOME}/.claude/settings.json`]: JSON.stringify({ hooks: { PreToolUse: [{}, {}], Stop: [{}] } }),
      [`${PROJECT}/.claude/settings.json`]: JSON.stringify({ hooks: { Stop: [{}] } }),
      [`${PROJECT}/.claude/settings.local.json`]: JSON.stringify({ hooks: { SessionStart: [{}] } }),
    };
    expect(counts(files).hookEvents).toBe(HOOK_EVENTS);
  });

  it("reads a pinned configuration directory and its own global file instead of the home directory's", () => {
    const files = {
      [`${HOME}/.claude/CLAUDE.md`]: "",
      [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { home: {} } }),
      "/pinned/CLAUDE.md": "",
      "/pinned/rules/r.md": "",
      "/pinned/.claude.json": JSON.stringify({ mcpServers: { a: {}, b: {} } }),
    };
    expect(counts(files, { env: { CLAUDE_CONFIG_DIR: "/pinned" } })).toEqual({ claudeMd: 1, rules: 1, mcpServers: 2, hookEvents: 0 });
  });

  it("reads a project whose .claude directory is the user's own once, as the user scope", () => {
    const files = {
      [`${HOME}/.claude/CLAUDE.md`]: "",
      [`${HOME}/.claude/rules/a.md`]: "",
      [`${HOME}/.claude/settings.json`]: JSON.stringify({ hooks: { Stop: [{}] }, mcpServers: { a: {} } }),
    };
    expect(counts(files, { project: HOME })).toEqual({ claudeMd: 1, rules: 1, mcpServers: 1, hookEvents: 1 });
  });

  it("counts a CLAUDE.md that is a link to a file, and not one that is a broken link, a link to a directory or a directory", () => {
    const real = { "/real/CLAUDE.md": "" };
    expect(counts(real, { links: { [`${HOME}/.claude/CLAUDE.md`]: "/real/CLAUDE.md" } }).claudeMd).toBe(1);
    expect(counts(real, { links: { [`${HOME}/.claude/CLAUDE.md`]: "/real/missing.md" } }).claudeMd).toBe(0);
    expect(counts({ "/real/dir/inner.txt": "" }, { links: { [`${HOME}/.claude/CLAUDE.md`]: "/real/dir" } }).claudeMd).toBe(0);
    expect(counts({ [`${HOME}/.claude/CLAUDE.md/inner.txt`]: "" }).claudeMd).toBe(0);
  });

  it.skipIf(process.platform === "win32")("counts a CLAUDE.md that is a FIFO, or a link to one, and no FIFO under a rules directory, as claude-hud counts only regular files there", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-config-"));
    try {
      const configuration = path.join(directory, "configuration");
      const rules = path.join(configuration, "rules");
      fs.mkdirSync(rules, { recursive: true });
      execFileSync("mkfifo", [path.join(configuration, "CLAUDE.md")]);
      execFileSync("mkfifo", [path.join(rules, "pipe.md")]);
      fs.symlinkSync(path.join(rules, "pipe.md"), path.join(rules, "to-pipe.md"));
      fs.writeFileSync(path.join(rules, "file.md"), "");
      const project = path.join(directory, "project");
      fs.mkdirSync(project);
      execFileSync("mkfifo", [path.join(directory, "pipe")]);
      fs.symlinkSync(path.join(directory, "pipe"), path.join(project, "CLAUDE.md"));
      const ports = realStatuslinePorts({ CLAUDE_CONFIG_DIR: configuration }, path.join(directory, "state"));
      expect(countConfiguration(ports, project)).toMatchObject({ claudeMd: 2, rules: 1 });
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")("counts a CLAUDE.md that is a socket or a link to a device, and no socket or device under a rules directory, as claude-hud counts only regular files there", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-config-"));
    const ruleServer = net.createServer();
    const projectServer = net.createServer();
    try {
      const configuration = path.join(directory, "c");
      const rules = path.join(configuration, "rules");
      fs.mkdirSync(rules, { recursive: true });
      fs.writeFileSync(path.join(rules, "file.md"), "");
      fs.symlinkSync("/dev/null", path.join(rules, "null.md"));
      fs.symlinkSync("/dev/null", path.join(configuration, "CLAUDE.md"));
      const project = path.join(directory, "p");
      fs.mkdirSync(project);
      await listening(ruleServer, path.join(rules, "s.md"));
      await listening(projectServer, path.join(project, "CLAUDE.md"));
      const ports = realStatuslinePorts({ CLAUDE_CONFIG_DIR: configuration }, path.join(directory, "state"));
      expect(countConfiguration(ports, project)).toMatchObject({ claudeMd: 2, rules: 1 });
    } finally {
      await Promise.all([ruleServer, projectServer].map(closed));
      fs.rmSync(directory, { recursive: true });
    }
  });

  it("counts a rules entry by the name it is listed under, ending in .md exactly, a file once however many links reach it, and no broken link", () => {
    const rules = `${HOME}/.claude/rules`;
    const kept = { [`${rules}/kept.md`]: "" };
    // Named .md, linking to nothing.
    expect(counts(kept, { links: { [`${rules}/broken.md`]: "/real/missing.md" } }).rules).toBe(1);
    // Named .md, linking to a file that is not.
    expect(counts({ ...kept, "/real/notes.txt": "" }, { links: { [`${rules}/named.md`]: "/real/notes.txt" } }).rules).toBe(2);
    // Two links to one file outside the tree.
    expect(counts({ ...kept, "/real/one.md": "" }, { links: { [`${rules}/first.md`]: "/real/one.md", [`${rules}/second.md`]: "/real/one.md" } }).rules).toBe(2);
    // The suffix in capitals, and the suffix's letters with no dot before them.
    expect(counts({ ...kept, [`${rules}/UPPER.MD`]: "", [`${rules}/xmd`]: "" }).rules).toBe(1);
  });

  it("walks into a link to a directory in a rules tree even when its name ends in .md, and counts a link to a file", () => {
    const files = { "/real/rules/inside.md": "", "/real/other.md": "", "/real/folder/deep.md": "", "/real/folder/deeper.md": "" };
    const links = { [`${HOME}/.claude/rules`]: "/real/rules", "/real/rules/folder.md": "/real/folder", "/real/rules/file.md": "/real/other.md" };
    expect(counts(files, { links }).rules).toBe(RULES_FILES + 1);
  });

  it("reads a file over the size bound as holding nothing, and one under it whole", () => {
    const mebibyte = 1_048_576;
    const padded = (mebibytes: number): string => JSON.stringify({ mcpServers: { a: {} }, padding: "x".repeat(mebibytes * mebibyte) });
    expect(counts({ [`${HOME}/.claude.json`]: padded(OVER_BOUND_MEBIBYTES) }).mcpServers).toBe(0);
    expect(counts({ [`${HOME}/.claude.json`]: padded(UNDER_BOUND_MEBIBYTES) }).mcpServers).toBe(1);
  });

  it("reads a file that is not valid JSON, or has fields of the wrong type, as holding nothing", () => {
    const files = {
      [`${HOME}/.claude/settings.json`]: "{ not json",
      [`${PROJECT}/.claude/settings.json`]: JSON.stringify({ mcpServers: ["a"], hooks: 3 }),
    };
    expect(counts(files)).toEqual({ claudeMd: 0, rules: 0, mcpServers: 0, hookEvents: 0 });
  });
});
