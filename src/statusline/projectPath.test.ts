import { describe, expect, it } from "vitest";

import { ESCAPE } from "./ansi";
import { parseClientPayload } from "./payload";
import { addedDirNames, formatProjectPath, MAX_ADDED_DIR_NAME_CHARS, MAX_ADDED_DIRS_SHOWN, workingDirectoryOf } from "./projectPath";

describe("formatProjectPath", () => {
  it("shows the last levels of a POSIX path, or all of it", () => {
    expect(formatProjectPath("/Users/joe/code/agent-shim", "1")).toBe("agent-shim");
    expect(formatProjectPath("/Users/joe/code/agent-shim", "2")).toBe("code/agent-shim");
    expect(formatProjectPath("/Users/joe/code/agent-shim", "3")).toBe("joe/code/agent-shim");
    expect(formatProjectPath("/Users/joe/code/agent-shim", "full")).toBe("/Users/joe/code/agent-shim");
  });

  it("shows a path with fewer directories than levels whole, without the leading slash", () => {
    expect(formatProjectPath("/home", "3")).toBe("home");
  });

  it("names the root as a slash", () => {
    expect(formatProjectPath("/", "1")).toBe("/");
    expect(formatProjectPath("/", "full")).toBe("/");
  });

  it("reads Windows drive and UNC paths with either separator and writes them with forward slashes", () => {
    expect(formatProjectPath("C:\\Users\\joe\\project", "2")).toBe("joe/project");
    expect(formatProjectPath("C:\\Users\\joe\\project", "full")).toBe("C:/Users/joe/project");
    expect(formatProjectPath("C:\\", "full")).toBe("C:/");
    expect(formatProjectPath("\\\\server\\share\\dir", "full")).toBe("//server/share/dir");
    expect(formatProjectPath("\\\\", "full")).toBe("//");
  });

  it("keeps a relative path relative", () => {
    expect(formatProjectPath("a/b/c", "full")).toBe("a/b/c");
  });

  it("removes control sequences the path carries", () => {
    expect(formatProjectPath(`/tmp/${ESCAPE}[31mred${ESCAPE}[0m`, "1")).toBe("red");
  });
});

describe("addedDirNames", () => {
  it("names each directory by its last component", () => {
    expect(addedDirNames(["/work/sparkle", "C:\\work\\lib-foo"])).toEqual({ names: ["sparkle", "lib-foo"], more: 0 });
  });

  it("names none when none were added", () => {
    expect(addedDirNames(undefined)).toEqual({ names: [], more: 0 });
    expect(addedDirNames([])).toEqual({ names: [], more: 0 });
  });

  it("names the first few and counts the rest", () => {
    const dirs = Array.from({ length: MAX_ADDED_DIRS_SHOWN + 2 }, (_, index) => `/w/d${String(index)}`);
    const { names, more } = addedDirNames(dirs);
    expect(names).toHaveLength(MAX_ADDED_DIRS_SHOWN);
    expect(names[0]).toBe("d0");
    expect(more).toBe(2);
  });

  it("ends a name that is too long in an ellipsis, at exactly the limit", () => {
    const atLimit = "x".repeat(MAX_ADDED_DIR_NAME_CHARS);
    const over = "y".repeat(MAX_ADDED_DIR_NAME_CHARS + 1);
    const { names } = addedDirNames([`/w/${atLimit}`, `/w/${over}`]);
    expect(names[0]).toBe(atLimit);
    expect(names[1]).toBe(`${"y".repeat(MAX_ADDED_DIR_NAME_CHARS - 1)}…`);
  });

  it("drops a directory whose name is nothing once sanitised", () => {
    expect(addedDirNames([`/w/${ESCAPE}[31m`, "/w/real"])).toEqual({ names: ["real"], more: 0 });
  });
});

describe("workingDirectoryOf", () => {
  it("prefers the client's cwd, then the workspace's current directory", () => {
    expect(workingDirectoryOf(parseClientPayload({ cwd: "/a", workspace: { current_dir: "/b" } }))).toBe("/a");
    expect(workingDirectoryOf(parseClientPayload({ workspace: { current_dir: "/b" } }))).toBe("/b");
  });

  it("is undefined when the client names none, or names an empty one", () => {
    expect(workingDirectoryOf(parseClientPayload({}))).toBeUndefined();
    expect(workingDirectoryOf(parseClientPayload({ cwd: "" }))).toBeUndefined();
  });
});
