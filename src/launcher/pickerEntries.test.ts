import { describe, expect, it } from "vitest";

import { pickerLabel } from "./pickerEntries";

describe("pickerLabel", () => {
  it("shows the bare identity name when nothing else is known", () => {
    expect(pickerLabel({ identity: "work" })).toBe("work");
  });

  it("puts the account and the quota after the name, each as the launch banner words them", () => {
    expect(pickerLabel({ identity: "work", account: "alex@example.com, Example Org (admin), 20x", quota: "5h 12% used, resets in 2h (recorded 5m ago)" })).toBe(
      "work | alex@example.com, Example Org (admin), 20x | 5h 12% used, resets in 2h (recorded 5m ago)",
    );
  });

  it("numbers a ranked entry, gives the ranking's heading and marks the pick", () => {
    expect(pickerLabel({ identity: "work", rank: 1, heading: "[scored score 1.20 by 7d reset]", picked: true, account: "alex@example.com" })).toBe(
      "1. work [scored score 1.20 by 7d reset] (picked) | alex@example.com",
    );
  });

  it("puts what qualifies an entry ahead of its account", () => {
    expect(pickerLabel({ identity: "work", detail: "refused until 2026-01-01T00:00:00.000Z (in 2h)", account: "alex@example.com" })).toBe(
      "work | refused until 2026-01-01T00:00:00.000Z (in 2h) | alex@example.com",
    );
  });

  it("leaves a part out rather than printing an empty one", () => {
    expect(pickerLabel({ identity: "work", quota: "5h 12% used (recorded 5m ago)" })).toBe("work | 5h 12% used (recorded 5m ago)");
  });
});
