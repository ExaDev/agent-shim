import { describe, expect, it } from "vitest";

import { decidePicker, isUnattendedLaunch, type PickerFacts } from "./pickerDecision";

/** A terminal launch with a pool pick that keeps the directory's account: the picker has no reason to appear. */
const SETTLED: PickerFacts = {
  interactive: true,
  unattended: false,
  pick: undefined,
  configDirEscapeHatch: false,
  waiting: false,
  selection: { kind: "pool", outcome: "keeps-account" },
};

describe("decidePicker", () => {
  it("does not ask when the pool pick keeps the account the directory last ran as", () => {
    expect(decidePicker(SETTLED)).toBeUndefined();
  });

  it("does not ask when a named identity is available", () => {
    expect(decidePicker({ ...SETTLED, selection: { kind: "identity", limited: false } })).toBeUndefined();
  });

  it("asks when no identity resolves", () => {
    expect(decidePicker({ ...SETTLED, selection: { kind: "none" } })).toBe("no-identity");
  });

  it("asks when the pool pick would change the account or organisation", () => {
    expect(decidePicker({ ...SETTLED, selection: { kind: "pool", outcome: "changes-account" } })).toBe("account-change");
  });

  it("asks when the picked identity is limited", () => {
    expect(decidePicker({ ...SETTLED, selection: { kind: "identity", limited: true } })).toBe("no-eligible-identity");
  });

  it("asks when every pool member is refused", () => {
    expect(decidePicker({ ...SETTLED, selection: { kind: "pool", outcome: "none-eligible" } })).toBe("no-eligible-identity");
  });

  it("leaves a refused pool to --wait when the launch said to wait", () => {
    expect(decidePicker({ ...SETTLED, waiting: true, selection: { kind: "pool", outcome: "none-eligible" } })).toBeUndefined();
  });

  it("still asks about an account change while waiting, since waiting does not move the account", () => {
    expect(decidePicker({ ...SETTLED, waiting: true, selection: { kind: "pool", outcome: "changes-account" } })).toBe("account-change");
  });

  it("never asks without a terminal, whatever the selection", () => {
    for (const selection of [{ kind: "none" }, { kind: "identity", limited: true }, { kind: "pool", outcome: "changes-account" }] as const) {
      expect(decidePicker({ ...SETTLED, interactive: false, selection })).toBeUndefined();
      expect(decidePicker({ ...SETTLED, interactive: false, pick: true, selection })).toBeUndefined();
    }
  });

  it("never asks an unattended launch for a reason of its own", () => {
    expect(decidePicker({ ...SETTLED, unattended: true, selection: { kind: "none" } })).toBeUndefined();
    expect(decidePicker({ ...SETTLED, unattended: true, selection: { kind: "pool", outcome: "changes-account" } })).toBeUndefined();
  });

  it("asks whenever interactive when --pick forces it, even for an unattended launch", () => {
    expect(decidePicker({ ...SETTLED, pick: true })).toBe("requested");
    expect(decidePicker({ ...SETTLED, pick: true, unattended: true })).toBe("requested");
    expect(decidePicker({ ...SETTLED, pick: true, selection: { kind: "none" } })).toBe("requested");
  });

  it("never asks under --no-pick", () => {
    expect(decidePicker({ ...SETTLED, pick: false, selection: { kind: "none" } })).toBeUndefined();
  });

  it("leaves a launch that names its own configuration directory alone, --pick included", () => {
    expect(decidePicker({ ...SETTLED, configDirEscapeHatch: true, selection: { kind: "none" } })).toBeUndefined();
    expect(decidePicker({ ...SETTLED, configDirEscapeHatch: true, pick: true })).toBeUndefined();
  });
});

describe("isUnattendedLaunch", () => {
  it("is true for a print run, in either spelling", () => {
    expect(isUnattendedLaunch(["-p", "hello"])).toBe(true);
    expect(isUnattendedLaunch(["--print", "hello"])).toBe(true);
    expect(isUnattendedLaunch(["--model", "opus", "-p"])).toBe(true);
  });

  it("is true for a background launch", () => {
    expect(isUnattendedLaunch(["--bg", "fix the build"])).toBe(true);
  });

  it("is true for a claude subcommand, which starts no session", () => {
    expect(isUnattendedLaunch(["plugin", "install", "x"])).toBe(true);
    expect(isUnattendedLaunch(["mcp", "list"])).toBe(true);
  });

  it("is false for an ordinary session, a resume included", () => {
    expect(isUnattendedLaunch([])).toBe(false);
    expect(isUnattendedLaunch(["--resume"])).toBe(false);
    expect(isUnattendedLaunch(["--model", "opus", "fix the build"])).toBe(false);
  });

  it("reads only the tokens before a terminator, since the rest belongs to a command claude runs", () => {
    expect(isUnattendedLaunch(["--", "-p", "--bg"])).toBe(false);
    expect(isUnattendedLaunch(["fix the build", "--", "-p"])).toBe(false);
  });
});
