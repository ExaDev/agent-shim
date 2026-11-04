import { Command } from "commander";
import { expect, it, vi } from "vitest";

import { registerHeadlessCommands } from "./headlessCommands";
import { fakeCommandDeps, paths } from "./test-helpers";

const mocks = vi.hoisted(() => ({ refresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./realCatalogueRefresh", () => ({ refreshCatalogueForReal: mocks.refresh }));

it("passes the supervisor generation to the catalogue refresh child", async () => {
  const generation = "10000000-0000-4000-8000-000000000001";
  const supervisorPid = 123;
  const program = new Command().exitOverride();
  registerHeadlessCommands(program, fakeCommandDeps(paths));
  await program.parseAsync(["__refresh-catalogue", "c", String(supervisorPid), generation], { from: "user" });
  expect(mocks.refresh).toHaveBeenCalledWith(paths, "c", process.env, supervisorPid, generation);
});
