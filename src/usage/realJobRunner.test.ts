import { describe, expect, it } from "vitest";

import { JOB_ISOLATION_OPTIONS } from "./realJobRunner";

describe("JOB_ISOLATION_OPTIONS", () => {
  it("loads only the user's own settings and starts no MCP server, so a repository's committed files can never add code an unattended run executes", () => {
    expect(JOB_ISOLATION_OPTIONS).toEqual({ settingSources: ["user"], mcpServers: {}, strictMcpConfig: true });
  });
});
