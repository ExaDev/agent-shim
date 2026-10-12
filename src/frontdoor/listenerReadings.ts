import fs from "node:fs";

import type { LayoutPaths } from "../paths";
import type { FrontDoorState } from "./state";
import { probeFrontDoorSync, probeListenerAcceptSync, type ListenerVerdict } from "./probe";

/** One listener of the front door as `doctor` and `frontdoor status` read it: whether it accepted within the probe's bound, and how long the answer took on this machine now. */
export interface FrontDoorListenerReading {
  /** Which listener, and so which sessions it cuts off when it does not accept: `provider` carries provider sessions, `connect` carries every plain OAuth session. */
  readonly listener: "provider" | "connect";
  readonly port: number;
  readonly ok: boolean;
  /** The probe's own failure reason, absent when it passed. */
  readonly reason?: string;
  /** Milliseconds the probe took, as the local clock saw it: a label on a reading, never a threshold. */
  readonly elapsedMs: number;
}

/** What reads the listeners: each probe authenticates or connects and answers with a verdict, and the clock times it. Injected so the reading runs against fakes. */
export interface FrontDoorListenerProbes {
  readonly authenticateProvider: (port: number) => ListenerVerdict;
  readonly connect: (port: number) => ListenerVerdict;
  readonly now: () => number;
}

/**
 * Reads both listeners of the door the state file names, when its supervisor is alive and both ports are recorded; nothing otherwise, since a door that is not running has no listener to accept. The two probes are made in turn, the provider listener first, each timed on its own.
 */
export function readFrontDoorListeners(state: Readonly<FrontDoorState>, supervisorAlive: boolean, probes: Readonly<FrontDoorListenerProbes>): readonly FrontDoorListenerReading[] {
  if (!supervisorAlive) {
    return [];
  }
  const readings: FrontDoorListenerReading[] = [];
  const take = (listener: FrontDoorListenerReading["listener"], port: number | undefined, probe: (port: number) => ListenerVerdict): void => {
    if (port === undefined) {
      return;
    }
    const started = probes.now();
    const verdict = probe(port);
    readings.push({ listener, port, ok: verdict.ok, ...(verdict.ok ? {} : { reason: verdict.reason }), elapsedMs: Math.max(0, probes.now() - started) });
  };
  take("provider", state.port, probes.authenticateProvider);
  take("connect", state.connectPort, probes.connect);
  return readings;
}

/** The real probes: the CA-verified health check on the provider listener, a plain accept on the CONNECT surface, and the monotonic clock. */
export function realFrontDoorListenerProbes(paths: LayoutPaths): FrontDoorListenerProbes {
  return {
    authenticateProvider: (port) => probeFrontDoorSync(port, fs.readFileSync(paths.frontdoorCaCertFile, "utf8")),
    connect: probeListenerAcceptSync,
    now: () => performance.now(),
  };
}
