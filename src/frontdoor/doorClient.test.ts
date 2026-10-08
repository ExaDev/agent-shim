import { describe, expect, it } from "vitest";

import { CliError } from "../cliError";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { FrontDoorControlMaterialError, FrontDoorNotServingError, frontDoorApiFromState, readFrontDoorControlMaterial } from "./doorClient";
import { writeFrontDoorState } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const SUPERVISOR = 10;
const PORT = 4100;

/** A filesystem holding a serving door's state, and as much of its control material as the caller gives. */
function door(material: { readonly ca?: string; readonly token?: string } = {}): ReturnType<typeof createFakeFarmFs> {
  const fs = createFakeFarmFs({});
  writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR, port: PORT, lastPort: PORT });
  fs.mkdirp(paths.frontdoorCaDir);
  if (material.ca !== undefined) {
    fs.writeFileUtf8(paths.frontdoorCaCertFile, material.ca);
  }
  if (material.token !== undefined) {
    fs.writeFileUtf8(paths.frontdoorControlTokenFile, material.token);
  }
  return fs;
}

describe("readFrontDoorControlMaterial", () => {
  it("returns the serving port, the CA and the token with its trailing newline trimmed", () => {
    expect(readFrontDoorControlMaterial(door({ ca: "ca-pem", token: "the-control-token\n" }), paths, "its typed API")).toEqual({ port: PORT, ca: "ca-pem", token: "the-control-token" });
  });

  it("refuses with a typed error when the door is not serving", () => {
    const attempt = (): unknown => readFrontDoorControlMaterial(createFakeFarmFs({}), paths, "its typed API");
    expect(attempt).toThrow(FrontDoorNotServingError);
    expect(attempt).toThrow("the front door is not serving");
  });

  it("names the missing CA, completing the sentence with the client being opened", () => {
    const attempt = (): unknown => readFrontDoorControlMaterial(door({ token: "t" }), paths, "its control listener");
    expect(attempt).toThrow(FrontDoorControlMaterialError);
    expect(attempt).toThrow(`the front door's CA certificate is missing at ${paths.frontdoorCaCertFile}, so its control listener cannot be authenticated`);
  });

  it("names the missing or empty control token", () => {
    expect(() => readFrontDoorControlMaterial(door({ ca: "ca-pem" }), paths, "its typed API")).toThrow(`the serving front door's control token is missing at ${paths.frontdoorControlTokenFile}`);
    expect(() => readFrontDoorControlMaterial(door({ ca: "ca-pem", token: "  \n" }), paths, "its typed API")).toThrow(FrontDoorControlMaterialError);
  });

  it("raises errors a caller can tell from a crash", () => {
    expect(new FrontDoorNotServingError()).toBeInstanceOf(CliError);
    expect(new FrontDoorControlMaterialError("x")).toBeInstanceOf(CliError);
  });
});

describe("frontDoorApiFromState", () => {
  it("opens the whole door's typed API client over the serving door's material", () => {
    const client = frontDoorApiFromState(paths, door({ ca: "ca-pem", token: "the-control-token" }));
    expect(typeof client.rc.subscribe).toBe("function");
    expect(typeof client.events.subscribe).toBe("function");
  });

  it("refuses when the door is not serving, rather than opening a client that dials nothing", () => {
    expect(() => frontDoorApiFromState(paths, createFakeFarmFs({}))).toThrow(FrontDoorNotServingError);
  });
});
