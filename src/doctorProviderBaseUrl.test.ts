import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, provider } from "./doctorTestFixtures";

describe("runDoctor: a stored provider's base URL", () => {
  it("fails a stored provider whose base URL has a scheme nothing dials or names port 0, naming the field and the way out, without crashing the load", () => {
    const credential = { sources: [{ literal: "placeholder" }] };
    const report = runDoctor(
      baseParams({
        providers: [
          provider("zero", { displayName: "zero", baseUrl: "http://localhost:0/", credential }),
          provider("ftp", { displayName: "ftp", baseUrl: "ftp://example.com/", credential }),
        ],
      }),
    );
    const [zero, ftp] = findingsFor(report, "provider");
    expect(zero?.severity).toBe("fail");
    expect(zero?.message).toContain("baseUrl");
    expect(zero?.message).toContain("must not name port 0");
    expect(ftp?.severity).toBe("fail");
    expect(ftp?.message).toContain("baseUrl");
    expect(ftp?.message).toContain("must be an http or https URL, not ftp");
  });
});
