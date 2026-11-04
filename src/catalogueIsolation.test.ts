import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { writeFrontDoorCodexHome, writeFrontDoorState } from "./frontdoor/state";
import { providerModels } from "./models/targets";
import { buildLayoutPaths } from "./paths";
import { catalogueCachePath, parseCatalogueCache } from "./providerCatalogue";
import { refreshCatalogueForReal } from "./realCatalogueRefresh";
import { realFarmFs } from "./realPorts";

vi.mock("./blockingSpawn", () => ({ spawnSyncBlocking: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }) }));
vi.mock("./codex/commands", () => ({ createCodexRoutePorts: () => ({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "account-token", accountId: "workspace" }) } } } }) }));

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("keeps a successor's real catalogue readable when an older refresh finishes after handover", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-catalogue-isolation-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "account-token", account_id: "workspace" } }));
  vi.stubEnv("CODEX_HOME", codexHome);
  const generation = "10000000-0000-4000-8000-000000000001";
  let releaseOld: (response: Response) => void = () => { throw new Error("Old request did not start"); };
  const oldResponse = new Promise<Response>((resolve) => { releaseOld = resolve; });
  const fetch = vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ slug: "new-model", visibility: "list" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.ppid, port: 1234 });
  const old = refreshCatalogueForReal(paths, "c", { CODEX_HOME: codexHome }, process.ppid, generation);
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, codexHome, generation);
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  await refreshCatalogueForReal(paths, "c", { CODEX_HOME: codexHome }, process.pid, generation);
  releaseOld(new Response(JSON.stringify({ models: [{ slug: "old-model", visibility: "list" }] }), { status: 200 }));
  await expect(old).rejects.toThrow("front door changed during catalogue refresh");
  expect(parseCatalogueCache(fs.readFileSync(catalogueCachePath(paths, "c", process.pid, generation), "utf8"))?.models).toEqual([{ id: "new-model" }]);
  expect(providerModels(paths)).toContainEqual({ provider: "c", model: "new-model" });
});
