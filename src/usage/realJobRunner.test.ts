import { describe, expect, it } from "vitest";

import { JOB_SETTING_SOURCES } from "./realJobRunner";

describe("JOB_SETTING_SOURCES", () => {
  it("loads only the user's own settings, so a repository's committed settings can never add a hook or permission to an unattended run", () => {
    expect(JOB_SETTING_SOURCES).toEqual(["user"]);
  });
});
