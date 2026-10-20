import { describe, expect, it } from "vitest";

import type { StatuslinePorts } from "../ports";
import { fakeStatuslinePorts } from "../testing";
import { isJjRepository, MAX_LABEL_CODE_POINTS, readJjStatus } from "./jj";

const FS = "\u001f";
const RS = "\u001e";

/** Ports over a fake tree: each key of `tree` is a path, mapped to the kind of entry there; a path that is its own real path unless `links` says otherwise. */
function treePorts(tree: Readonly<Record<string, "directory" | "other">>, links: Readonly<Record<string, string>> = {}): StatuslinePorts {
  return fakeStatuslinePorts({
    entryKind: (path) => tree[path],
    realPath: (path) => links[path] ?? (path in tree ? path : undefined),
  });
}

describe("isJjRepository", () => {
  it("finds a .jj directory in the working directory or an ancestor", () => {
    expect(isJjRepository(treePorts({ "/r": "directory", "/r/.jj": "directory", "/r/a": "directory", "/r/a/b": "directory" }), "/r/a/b")).toBe(true);
    expect(isJjRepository(treePorts({ "/r": "directory", "/r/.jj": "directory" }), "/r")).toBe(true);
  });

  it("is false with no .jj anywhere up to the root", () => {
    expect(isJjRepository(treePorts({ "/": "directory", "/r": "directory" }), "/r")).toBe(false);
  });

  it("does not follow a .jj that is a link or a file", () => {
    expect(isJjRepository(treePorts({ "/r": "directory", "/r/.jj": "other" }), "/r")).toBe(false);
  });

  it("stops at a .git entry, so a nested git repository is not read as the outer jj one", () => {
    const tree = { "/r": "directory", "/r/.jj": "directory", "/r/inner": "directory", "/r/inner/.git": "directory", "/r/inner/src": "directory" } as const;
    expect(isJjRepository(treePorts(tree), "/r/inner/src")).toBe(false);
    expect(isJjRepository(treePorts(tree), "/r")).toBe(true);
  });

  it("stops at a .git file, which a worktree has", () => {
    expect(isJjRepository(treePorts({ "/r": "directory", "/r/.jj": "directory", "/r/wt": "directory", "/r/wt/.git": "other" }), "/r/wt")).toBe(false);
  });

  it("walks up from the real path of a linked working directory, not from the link", () => {
    const tree = { "/": "directory", "/real": "directory", "/real/.jj": "directory", "/real/sub": "directory", "/elsewhere": "directory", "/r": "directory", "/r/.jj": "directory", "/plain": "directory" } as const;
    expect(isJjRepository(treePorts(tree, { "/elsewhere/link": "/real/sub" }), "/elsewhere/link")).toBe(true);
    expect(isJjRepository(treePorts(tree, { "/r/link": "/plain" }), "/r/link")).toBe(false);
  });

  it("is false for a directory that does not exist or is not one", () => {
    expect(isJjRepository(treePorts({}), "/missing")).toBe(false);
    expect(isJjRepository(treePorts({ "/f": "other" }), "/f")).toBe(false);
  });
});

describe("readJjStatus", () => {
  function jjPorts(output: string | undefined): { readonly ports: StatuslinePorts; readonly calls: { file: string; args: readonly string[]; cwd: string }[] } {
    const calls: { file: string; args: readonly string[]; cwd: string }[] = [];
    const ports = fakeStatuslinePorts({
      realPath: (path) => path,
      run: (file, args, cwd) => {
        calls.push({ file, args, cwd });
        return output;
      },
    });
    return { ports, calls };
  }

  it("reads the first bookmark, the dirty flag and the conflict flag from one read-only call", () => {
    const { ports, calls } = jjPorts(`wrulwzyw${FS}main${RS}other${FS}1${FS}0\n`);
    expect(readJjStatus(ports, "/r")).toEqual({ kind: "jj", branch: "main", detached: false, dirty: true, conflict: false, ahead: 0, behind: 0, lineDiff: undefined, files: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: "jj", cwd: "/r" });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--ignore-working-copy", "--no-pager", "--color", "never"]));
  });

  it("falls back to the change id when no bookmark is at the working copy, and reads a conflict", () => {
    expect(readJjStatus(jjPorts(`wrulwzyw${FS}${FS}0${FS}1\n`).ports, "/r")).toMatchObject({ branch: "wrulwzyw", dirty: false, conflict: true });
  });

  it("cuts a long label at a code point", () => {
    const long = "é".repeat(MAX_LABEL_CODE_POINTS + 1);
    expect(Array.from(readJjStatus(jjPorts(`id${FS}${long}${FS}0${FS}0`).ports, "/r")?.branch ?? "")).toHaveLength(MAX_LABEL_CODE_POINTS);
  });

  it("refuses output that is not the shape the template makes", () => {
    for (const output of [undefined, "", `id${FS}${FS}0`, `id${FS}${FS}2${FS}0`, `id${FS}a${RS}${RS}b${FS}0${FS}0`, `id${FS}${FS}0${FS}0\nextra`, `${FS}${FS}0${FS}0`]) {
      expect(readJjStatus(jjPorts(output).ports, "/r"), JSON.stringify(output)).toBeUndefined();
    }
  });

  it("is undefined when the directory has no real path", () => {
    expect(readJjStatus(fakeStatuslinePorts({ run: () => `id${FS}${FS}0${FS}0` }), "/r")).toBeUndefined();
  });
});
