import { describe, expect, it, vi } from "vitest";

import { resolveWithAsyncRuns, type AsyncRun } from "./replayRun";

const OK = { status: 0, stdout: "answer\n", stderr: "" };

describe("resolveWithAsyncRuns", () => {
  it("returns the decision's result when it asks for no command, without running one", async () => {
    const runAsync = vi.fn<AsyncRun>();
    expect(await resolveWithAsyncRuns(() => "decided", runAsync)).toBe("decided");
    expect(runAsync).not.toHaveBeenCalled();
  });

  it("runs each command the decision asks for and starts the decision again with the answers", async () => {
    const runAsync = vi.fn<AsyncRun>(async (command, args) => await Promise.resolve({ status: 0, stdout: `${command} ${args.join(" ")}`, stderr: "" }));
    const result = await resolveWithAsyncRuns((run) => `${run.run("git", ["rev-parse"]).stdout}|${run.run("security", ["find"]).stdout}`, runAsync);
    expect(result).toBe("git rev-parse|security find");
    expect(runAsync.mock.calls).toEqual([
      ["git", ["rev-parse"]],
      ["security", ["find"]],
    ]);
  });

  it("runs a command once however many times the decision asks for it", async () => {
    const runAsync = vi.fn<AsyncRun>(async () => await Promise.resolve(OK));
    await resolveWithAsyncRuns((run) => [run.run("git", ["a"]), run.run("git", ["a"]), run.run("git", ["b"])].length, runAsync);
    expect(runAsync).toHaveBeenCalledTimes(2);
  });

  it("tells commands apart by their arguments", async () => {
    const runAsync = vi.fn<AsyncRun>(async (_command, args) => await Promise.resolve({ status: 0, stdout: args.join(","), stderr: "" }));
    const result = await resolveWithAsyncRuns((run) => [run.run("git", ["a", "b"]).stdout, run.run("git", ["a,b"]).stdout], runAsync);
    expect(result).toEqual(["a,b", "a,b"]);
    expect(runAsync).toHaveBeenCalledTimes(2);
  });

  it("hands the decision a failed command's status and output as they came", async () => {
    const runAsync = vi.fn<AsyncRun>(async () => await Promise.resolve({ status: 128, stdout: "", stderr: "not a repository" }));
    expect(await resolveWithAsyncRuns((run) => run.run("git", ["rev-parse"]), runAsync)).toEqual({ status: 128, stdout: "", stderr: "not a repository" });
  });

  it("lets the decision's own failure through unchanged, without running anything further", async () => {
    const runAsync = vi.fn<AsyncRun>(async () => await Promise.resolve(OK));
    await expect(
      resolveWithAsyncRuns((run) => {
        run.run("git", ["a"]);
        throw new Error("refused");
      }, runAsync),
    ).rejects.toThrow("refused");
    expect(runAsync).toHaveBeenCalledTimes(1);
  });
});
