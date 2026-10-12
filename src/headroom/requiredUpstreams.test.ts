import { describe, expect, it } from "vitest";

import { writeFrontDoorState } from "../frontdoor/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { launchRequiredUpstreams } from "./supervisor";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const DOOR_DIRECT_PORT = 50123;
const DOOR_ORIGIN = `http://127.0.0.1:${String(DOOR_DIRECT_PORT)}`;

describe("launchRequiredUpstreams", () => {
  it("needs only the direct origin of the door state.json names, whatever providers exist", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    fs.mkdirp(paths.providersDir);
    fs.writeFileUtf8(`${paths.providersDir}/m.json`, JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", credential: { sources: [{ env: "T" }] } }));
    expect(launchRequiredUpstreams(fs, paths)).toEqual([DOOR_ORIGIN]);
  });

  it("needs nothing before any front door has served", () => {
    expect(launchRequiredUpstreams(createFakeFarmFs({}), paths)).toEqual([]);
  });
});
