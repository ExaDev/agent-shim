import net from "node:net";

import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { createDoorEventHub } from "./eventHub";
import { createDoorHealthPublisher } from "./doorHealthEvents";
import type { HandoverListenerName, HandoverOutcome, HandoverSockets, ListenSource, Predecessor } from "./handover";
import { createLaunchEventPublisher } from "./launchEvents";
import { createLiveSessionRegistry } from "./liveSessionRegistry";
import { FRONT_DOOR_PROTOCOL, readFrontDoorState } from "./state";
import { FRONTDOOR_POLL_MS, type FrontDoorSupervisorPorts, type OwnExecutableStat } from "./supervisor";

export const paths = buildLayoutPaths("/home/testuser/.agent-shim");

/** A stand-in capability: the registry records one per launch, and the supervisor must see a record that carries it. */
export const SESSION_TOKEN = "test-capability";
export const OWN_PID = 4242;
export const SUCCESSOR_PID = 4243;
export const LIVE_SESSION = 301;
export const NEW_SESSION = 303;
export const DEAD_SESSION = 302;
export const STICKY_PORT = 4100;
export const STICKY_CONNECT_PORT = 4300;
export const STICKY_DIRECT_PORT = 4400;
export const OCCUPIED_PORT = 4200;
export const FRESH_PORT = 5001;
export const IDLE_MINUTES = 1;
export const MS_PER_MINUTE = 60_000;
/** Microtask turns that carry the supervisor through its awaits to the next point a test can observe. */
const SETTLE_TURNS = 50;
/** Ticks the abort-listener probe runs: enough that an accumulating listener would exceed the single one a wait holds. */
export const LEAK_PROBE_TICKS = 20;
/** Ticks beyond the idle window itself, so an unwanted shutdown cannot hide behind the tick limit. */
export const SLACK_TICKS = 5;
export const FULL_IDLE_WINDOW_TICKS = Math.ceil((IDLE_MINUTES * MS_PER_MINUTE) / FRONTDOOR_POLL_MS) + SLACK_TICKS;
const SUCCESSOR_PORT = 5101;
const SUCCESSOR_CONNECT_PORT = 5102;
const SUCCESSOR_DIRECT_PORT = 5103;
/** The state a newer supervisor records once it serves, on ports of its own because the superseded door still holds the sticky ones. */
export const SUCCESSOR_STATE = { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: SUCCESSOR_PID, port: SUCCESSOR_PORT, connectPort: SUCCESSOR_CONNECT_PORT, directPort: SUCCESSOR_DIRECT_PORT, lastPort: SUCCESSOR_PORT, lastConnectPort: SUCCESSOR_CONNECT_PORT, lastDirectPort: SUCCESSOR_DIRECT_PORT };
/** The installed binary as the door starts serving it: every field differs in the replacement, the way a rename-install's new inode does. */
export const INSTALLED_BINARY: OwnExecutableStat = { dev: 1, ino: 10, size: 4096, mtimeMs: 0 };
export const REPLACED_BINARY: OwnExecutableStat = { dev: 1, ino: 11, size: 4097, mtimeMs: 1 };

/** What a fake listener start was given: the preferred port of a bind, or the listener a successor adopted. */
type FakeBind = number | undefined | { readonly adopted: HandoverListenerName };

/**
 * The fake world the supervisor runs against: an in-memory filesystem, a clock advanced only by the supervisor's own sleeps, a modelled process table, and listeners that bind the preferred port when it is free and the fresh one otherwise (the real listeners' bind-time fallback). `onSleep` lets a test act between ticks.
 */
export function makeWorld(options: { readonly ownPid?: number; readonly fs?: HeadroomFs; readonly predecessor?: Predecessor } = {}) {
  const fs = options.fs ?? createFakeFarmFs({});
  const ownPid = options.ownPid ?? OWN_PID;
  let clock = 0;
  const alive = new Set<number>([ownPid]);
  const occupied = new Set<number>([OCCUPIED_PORT]);
  const binds: FakeBind[] = [];
  const connectBinds: FakeBind[] = [];
  const directBinds: FakeBind[] = [];
  /** One listening socket per listener, standing in for the real ones: never bound, only compared, so a test can prove the handover was given exactly the sockets the door serves on. */
  const sockets: HandoverSockets = { provider: new net.Server(), connect: new net.Server(), direct: new net.Server() };
  /** The ports the fake listeners report for an adopted socket: the old door's sticky ports, which the socket is already bound to. */
  const adoptedPorts: Readonly<Record<HandoverListenerName, number>> = { provider: STICKY_PORT, connect: STICKY_CONNECT_PORT, direct: STICKY_DIRECT_PORT };
  /** Aborted by a test to model a launcher's request to hand over. */
  const handoverController = new AbortController();
  /** The sockets each handover was given, in order. */
  const handedOver: HandoverSockets[] = [];
  /** What the next handover resolves with; a test replaces it to model a successor that serves or one that fails. */
  let handoverOutcome: HandoverOutcome = { ok: true, successorPid: SUCCESSOR_PID };
  /** Runs inside the handover before it resolves, so a test can act while the successor is taking over (record the successor as the owner, as a real one does before it reports serving). */
  let onHandover: (() => void) | undefined;
  const closes: number[] = [];
  /** Every stop in the order it happened, so a test can prove what the shutdown sequence closes before what. */
  const stopOrder: string[] = [];
  /** The same stops with the watchdog's start and stop among them, so a test can prove where in the sequence the watchdog was ended. */
  const timeline: string[] = [];
  let hubCloses = 0;
  const logs: string[] = [];
  /** Aborted by a test to model the process being asked to exit. */
  const retireController = new AbortController();
  /** What a listener's drain waits on: open by default, held by a test that wants to observe the door while its connections are still being carried. */
  let drainGate: Promise<void> = Promise.resolve();
  let openDrainGate: () => void = () => undefined;
  /** The owner the state file named at the moment each listener was told to drain: the release of the addresses must come before the state stops naming this door. */
  const ownerAtDrain: (number | undefined)[] = [];
  let failListener = false;
  let failConnect = false;
  let failDirect = false;
  let onSleep: (() => void) | undefined;
  let onListenerStart: (() => void) | undefined;
  // The executable identity the door serves as, present by default so the existing idle behaviour runs with a matching stat (the no-drift case), replaceable or removable mid-run through the world's setter the way `agent-shim update`'s rename-install replaces the file between ticks.
  let ownExecutableStat: OwnExecutableStat | undefined = INSTALLED_BINARY;
  // The door's event backbone and its launch lifecycle publisher, the same pairing the real ports wire: the tick's registry facts go in through the port below and come out as source-tagged events a test subscribes for.
  const doorEvents = createDoorEventHub();
  const launchEvents = createLaunchEventPublisher(doorEvents, () => clock);
  /** How many ticks ran the expiring-quota check, so the tick's calling of it is itself observable. */
  let quotaChecks = 0;

  /** A fake listener's port: an adopted socket keeps the old door's port, and a bind takes the preferred port when it is free and the fresh one otherwise (the real listeners' bind-time fallback). */
  const fakePortOf = async (listener: HandoverListenerName, source: ListenSource, record: (bind: FakeBind) => void): Promise<number> => {
    if ("inherit" in source) {
      await source.inherit();
      record({ adopted: listener });
      return adoptedPorts[listener];
    }
    const preferred = source.preferredPort;
    record(preferred);
    return await Promise.resolve(preferred !== undefined && !occupied.has(preferred) ? preferred : FRESH_PORT);
  };

  const registry = createLiveSessionRegistry({ fs, sessionsDir: paths.frontdoorSessionsDir });
  const ports: FrontDoorSupervisorPorts = {
    fs,
    paths,
    registry,
    ownPid,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      onSleep?.();
      await Promise.resolve();
    },
    isRunning: (pid) => alive.has(pid),
    runningAmong: async (pids) => await Promise.resolve(new Set(pids.filter((pid) => alive.has(pid)))),
    statOwnExecutable: () => ownExecutableStat,
    startProviderListener: async (source) => {
      if (failListener) {
        throw new Error("port chaos");
      }
      onListenerStart?.();
      const port = await fakePortOf("provider", source, (bind) => {
        binds.push(bind);
      });
      return {
        port,
        listening: sockets.provider,
        close: async () => {
          closes.push(port);
          stopOrder.push("provider");
          timeline.push("provider");
          await Promise.resolve();
        },
        drain: async () => {
          stopOrder.push("drain-provider");
          timeline.push("drain-provider");
          ownerAtDrain.push(readFrontDoorState(fs, paths.frontdoorStateFile)?.supervisorPid);
          await drainGate;
        },
      };
    },
    startConnectListener: async (source) => {
      if (failConnect) {
        throw new Error("connect chaos");
      }
      const port = await fakePortOf("connect", source, (bind) => {
        connectBinds.push(bind);
      });
      return {
        port,
        listening: sockets.connect,
        close: async () => {
          closes.push(port);
          stopOrder.push("connect");
          timeline.push("connect");
          await Promise.resolve();
        },
        drain: async () => {
          stopOrder.push("drain-connect");
          timeline.push("drain-connect");
          ownerAtDrain.push(readFrontDoorState(fs, paths.frontdoorStateFile)?.supervisorPid);
          await drainGate;
        },
      };
    },
    startDirectListener: async (source) => {
      if (failDirect) {
        throw new Error("direct chaos");
      }
      const port = await fakePortOf("direct", source, (bind) => {
        directBinds.push(bind);
      });
      return {
        port,
        listening: sockets.direct,
        close: async () => {
          closes.push(port);
          stopOrder.push("direct");
          timeline.push("direct");
          await Promise.resolve();
        },
        drain: async () => {
          stopOrder.push("drain-direct");
          timeline.push("drain-direct");
          ownerAtDrain.push(readFrontDoorState(fs, paths.frontdoorStateFile)?.supervisorPid);
          await drainGate;
        },
      };
    },
    closeRcStreamHub: () => {
      hubCloses += 1;
      stopOrder.push("hub");
      timeline.push("hub");
    },
    startWatchdog: () => {
      timeline.push("watchdog-start");
      return {
        stop: () => {
          timeline.push("watchdog-stop");
        },
      };
    },
    observeLaunchRegistry: launchEvents.observe,
    // The door health publisher and the expiring-quota checker, the same pairing the real ports wire: the publisher over the same backbone the launch events ride, and the checker a recorder the tick calls.
    doorHealth: createDoorHealthPublisher(doorEvents, () => clock, ownPid),
    retire: retireController.signal,
    handover: {
      requested: handoverController.signal,
      run: async (handed) => {
        handedOver.push(handed);
        timeline.push("handover");
        onHandover?.();
        return await Promise.resolve(handoverOutcome);
      },
    },
    ...(options.predecessor === undefined ? {} : { predecessor: options.predecessor }),
    stopBackgroundWork: () => {
      stopOrder.push("background");
      timeline.push("background");
    },
    checkQuotaExpiry: () => {
      quotaChecks += 1;
    },
    log: (line) => {
      logs.push(line);
    },
  };

  return {
    fs,
    ports,
    /** The registry view the supervisor's tick refreshes: what the world's listeners would admit launches against. */
    registry,
    alive,
    occupied,
    binds,
    connectBinds,
    closes,
    stopOrder,
    timeline,
    hubCloses: () => hubCloses,
    ownerAtDrain,
    retireSignal: retireController.signal,
    /** Models the process being asked to exit. */
    retire: () => {
      retireController.abort();
    },
    /** Models a launcher asking the door to hand its listeners over. */
    requestHandover: () => {
      handoverController.abort();
    },
    sockets,
    handedOver,
    set handoverOutcome(value: HandoverOutcome) {
      handoverOutcome = value;
    },
    set onHandover(hook: (() => void) | undefined) {
      onHandover = hook;
    },
    /** Makes every listener's drain wait until `releaseDrains`, as a drain does while a tunnel is still open. */
    holdDrains: () => {
      drainGate = new Promise<void>((resolve) => {
        openDrainGate = resolve;
      });
    },
    releaseDrains: () => {
      openDrainGate();
    },
    doorEvents,
    quotaChecks: () => quotaChecks,
    logs,
    clock: () => clock,
    set failListener(value: boolean) {
      failListener = value;
    },
    set failConnect(value: boolean) {
      failConnect = value;
    },
    set failDirect(value: boolean) {
      failDirect = value;
    },
    /** Replaces or removes the installed binary's identity; setting it mid-run (from `onSleep`) models the update's rename landing between ticks. */
    set ownExecutable(value: OwnExecutableStat | undefined) {
      ownExecutableStat = value;
    },
    directBinds,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    /** Fired inside the provider listener's start, modelling an update landing during the door's own startup, between the identity baseline and the first tick. */
    set onListenerStart(hook: (() => void) | undefined) {
      onListenerStart = hook;
    },
  };
}


/** Lets the supervisor's pending microtasks run, so a test can observe it between awaits. */
export async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
    await Promise.resolve();
  }
}
