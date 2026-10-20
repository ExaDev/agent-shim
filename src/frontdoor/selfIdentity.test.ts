import { afterEach, describe, expect, it, vi } from "vitest";

import { declareThisProcessTheFrontDoor, isDeclaredFrontDoor, isFrontDoorSupervisorPid, resetFrontDoorDeclarationForTests } from "./selfIdentity";

/** Pids that are not this process's: one the identity check recognises and one it does not. */
const OTHER_DOOR_PID = process.pid + 1;
const UNRELATED_PID = process.pid + 2;

describe("isFrontDoorSupervisorPid", () => {
  afterEach(() => {
    resetFrontDoorDeclarationForTests();
  });

  it("answers for this process without asking anything else once it has declared itself the door", () => {
    const identify = vi.fn(() => false);
    declareThisProcessTheFrontDoor();
    expect(isFrontDoorSupervisorPid(process.pid, identify)).toBe(true);
    expect(identify).not.toHaveBeenCalled();
  });

  it("asks the identity check about any other pid, whatever this process has declared", () => {
    const identify = vi.fn((pid: number) => pid === OTHER_DOOR_PID);
    declareThisProcessTheFrontDoor();
    expect(isFrontDoorSupervisorPid(OTHER_DOOR_PID, identify)).toBe(true);
    expect(isFrontDoorSupervisorPid(UNRELATED_PID, identify)).toBe(false);
    expect(identify).toHaveBeenCalledTimes(2);
  });

  it("asks the identity check about this process too until it has declared itself", () => {
    const identify = vi.fn(() => false);
    expect(isFrontDoorSupervisorPid(process.pid, identify)).toBe(false);
    expect(identify).toHaveBeenCalledWith(process.pid);
  });
});

describe("isDeclaredFrontDoor", () => {
  afterEach(() => {
    resetFrontDoorDeclarationForTests();
  });

  it("is true only for this process, and only once it has declared itself the door", () => {
    expect(isDeclaredFrontDoor(process.pid)).toBe(false);
    declareThisProcessTheFrontDoor();
    expect(isDeclaredFrontDoor(process.pid)).toBe(true);
    expect(isDeclaredFrontDoor(OTHER_DOOR_PID)).toBe(false);
  });
});
