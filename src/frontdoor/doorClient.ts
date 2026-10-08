import { CliError } from "../cliError";
import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { frontDoorApiClient, type DoorApiClient } from "./controlApi";
import { readFrontDoorState } from "./state";

/** Raised when the front door is not serving, so there is no listener to open a client to. */
export class FrontDoorNotServingError extends CliError {
  constructor() {
    super("the front door is not serving: Remote Control sessions are observed only while it runs, so start a session through the door first");
    this.name = "FrontDoorNotServingError";
  }
}

/** Raised when the serving door's CA certificate or per-generation control token cannot be read, so a client could not authenticate the listener or itself. */
export class FrontDoorControlMaterialError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "FrontDoorControlMaterialError";
  }
}

/** What a client of the serving door's control surface needs: the provider listener's port, the CA that signs its certificate, and this generation's owner-only control token. */
export interface FrontDoorControlMaterial {
  readonly port: number;
  readonly ca: string;
  readonly token: string;
}

/**
 * Reads the serving door's control material from the state file `frontdoor status` reads, the CA path and the owner-only control token file. `purpose` completes the CA refusal's sentence ("so `purpose` cannot be authenticated") for the client being opened.
 *
 * Throws `FrontDoorNotServingError` when the state names no serving port, and `FrontDoorControlMaterialError` naming the missing file when the CA or the token cannot be read.
 */
export function readFrontDoorControlMaterial(fsPort: HeadroomFs, paths: LayoutPaths, purpose: string): FrontDoorControlMaterial {
  const state = readFrontDoorState(fsPort, paths.frontdoorStateFile);
  if (state?.port === undefined) {
    throw new FrontDoorNotServingError();
  }
  const ca = fsPort.readFileUtf8(paths.frontdoorCaCertFile);
  if (ca === undefined) {
    throw new FrontDoorControlMaterialError(`the front door's CA certificate is missing at ${paths.frontdoorCaCertFile}, so ${purpose} cannot be authenticated`);
  }
  const token = fsPort.readFileUtf8(paths.frontdoorControlTokenFile)?.trim();
  if (token === undefined || token === "") {
    throw new FrontDoorControlMaterialError(`the serving front door's control token is missing at ${paths.frontdoorControlTokenFile}`);
  }
  return { port: state.port, ca, token };
}

/**
 * Opens the whole typed API of the serving front door from the state root: the Remote Control operations (`rc.*`), the control plane (usage, status, check and doctor) and the door-wide event stream (`events.subscribe`), every call presenting the control token over TLS trusting only the door's own CA. It reads the same files the `frontdoor` verbs read, and no credential.
 *
 * Throws `FrontDoorNotServingError` when the door is not serving and `FrontDoorControlMaterialError` when its CA or control token is missing. The token belongs to one door generation, so a client opened before a restart is refused afterwards: open a new one.
 */
export function frontDoorApiFromState(paths: LayoutPaths, fsPort: HeadroomFs = realFarmFs): DoorApiClient {
  const { port, ca, token } = readFrontDoorControlMaterial(fsPort, paths, "its typed API");
  return frontDoorApiClient(port, ca, token);
}
