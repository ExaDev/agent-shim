import net from "node:net";
import { describe, expect, it } from "vitest";

import { HANDOVER_LISTENERS, HANDOVER_MESSAGE_VERSION, handOverListeners, predecessorOver, type HandoverOutcome, type HandoverSockets, type PredecessorChannel, type SuccessorChannel } from "./handover";

const SUCCESSOR_PID = 4243;
const BUDGET_MS = 1_000;
const KIND = "agent-shim-door-handover";

/** A take request as a successor of this release sends it. */
const take = (listener: string): unknown => ({ kind: KIND, version: HANDOVER_MESSAGE_VERSION, type: "take", listener });
const SERVING: unknown = { kind: KIND, version: HANDOVER_MESSAGE_VERSION, type: "serving" };

/** The old door's view of a spawned successor, driven by the test: messages it sends, its exit, and what the door did to it. */
function fakeSuccessor() {
  let deliver: ((message: unknown) => void) | undefined;
  let gone: ((description: string) => void) | undefined;
  const sent: { readonly listener: string; readonly socket: net.Server }[] = [];
  const events: string[] = [];
  const channel: SuccessorChannel = {
    pid: SUCCESSOR_PID,
    sendListener: (message, socket) => {
      sent.push({ listener: message.listener, socket });
    },
    onMessage: (listener) => {
      deliver = listener;
    },
    onGone: (listener) => {
      gone = listener;
    },
    release: () => {
      events.push("release");
    },
    kill: () => {
      events.push("kill");
    },
  };
  return {
    channel,
    sent,
    events,
    send: (message: unknown) => {
      deliver?.(message);
    },
    exit: (description: string) => {
      gone?.(description);
    },
  };
}

/** A timer the test fires by hand, so the budget's expiry is an event rather than a wait. */
function manualTimer() {
  let cancelled = false;
  let fire: (() => void) | undefined;
  const elapsed = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return {
    timers: {
      startTimer: () => ({
        elapsed,
        cancel: () => {
          cancelled = true;
        },
      }),
    },
    fire: () => {
      fire?.();
    },
    cancelled: () => cancelled,
  };
}

function sockets(): HandoverSockets {
  return { provider: new net.Server(), connect: new net.Server(), direct: new net.Server() };
}

describe("the old door's side of a handover", () => {
  it("answers each take with that listener's own socket and resolves with the successor once it serves, releasing it and cancelling the budget", async () => {
    const successor = fakeSuccessor();
    const timer = manualTimer();
    const held = sockets();
    const outcome = handOverListeners({ spawn: () => successor.channel, sockets: held, budgetMs: BUDGET_MS, timers: timer.timers });
    for (const listener of HANDOVER_LISTENERS) {
      successor.send(take(listener));
    }
    successor.send(SERVING);
    expect(await outcome).toEqual({ ok: true, successorPid: SUCCESSOR_PID });
    expect(successor.sent).toEqual(HANDOVER_LISTENERS.map((listener) => ({ listener, socket: held[listener] })));
    expect(successor.events).toEqual(["release"]);
    expect(timer.cancelled()).toBe(true);
  });

  it("fails and ends the successor when it exits before serving", async () => {
    const successor = fakeSuccessor();
    const outcome = handOverListeners({ spawn: () => successor.channel, sockets: sockets(), budgetMs: BUDGET_MS, timers: manualTimer().timers });
    successor.send(take("provider"));
    successor.exit("exited (code 1)");
    const result: HandoverOutcome = await outcome;
    expect(result).toEqual({ ok: false, reason: `successor ${String(SUCCESSOR_PID)} exited (code 1) before it was serving` });
    expect(successor.events).toEqual(["kill", "release"]);
  });

  it("fails and ends the successor when the budget runs out first", async () => {
    const successor = fakeSuccessor();
    const timer = manualTimer();
    const outcome = handOverListeners({ spawn: () => successor.channel, sockets: sockets(), budgetMs: BUDGET_MS, timers: timer.timers });
    timer.fire();
    expect(await outcome).toEqual({ ok: false, reason: `successor ${String(SUCCESSOR_PID)} was not serving within ${String(BUDGET_MS)}ms` });
    expect(successor.events).toEqual(["kill", "release"]);
  });

  it("fails on a message from another version of the exchange instead of guessing at it, and hands nothing over", async () => {
    const successor = fakeSuccessor();
    const outcome = handOverListeners({ spawn: () => successor.channel, sockets: sockets(), budgetMs: BUDGET_MS, timers: manualTimer().timers });
    successor.send({ kind: KIND, version: HANDOVER_MESSAGE_VERSION + 1, type: "take", listener: "provider" });
    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(successor.sent).toEqual([]);
    expect(successor.events).toEqual(["kill", "release"]);
  });

  it("settles once: an exit after serving changes nothing", async () => {
    const successor = fakeSuccessor();
    const outcome = handOverListeners({ spawn: () => successor.channel, sockets: sockets(), budgetMs: BUDGET_MS, timers: manualTimer().timers });
    successor.send(SERVING);
    successor.exit("closed its channel");
    expect(await outcome).toEqual({ ok: true, successorPid: SUCCESSOR_PID });
    expect(successor.events).toEqual(["release"]);
  });
});

/** The successor's view of the old door, driven by the test. */
function fakePredecessor() {
  let deliver: ((message: unknown, handle: unknown) => void) | undefined;
  let gone: ((description: string) => void) | undefined;
  const sent: unknown[] = [];
  const events: string[] = [];
  const channel: PredecessorChannel = {
    send: (message, written) => {
      sent.push(message);
      written?.();
    },
    onMessage: (listener) => {
      deliver = listener;
    },
    onGone: (listener) => {
      gone = listener;
    },
    release: () => {
      events.push("release");
    },
  };
  return {
    channel,
    sent,
    events,
    answer: (listener: string, handle: unknown) => {
      deliver?.({ kind: KIND, version: HANDOVER_MESSAGE_VERSION, type: "listener", listener }, handle);
    },
    close: () => {
      gone?.("closed");
    },
  };
}

const isServer = (handle: unknown): handle is net.Server => handle instanceof net.Server;

describe("the successor's side of a handover", () => {
  it("asks for one listener at a time and resolves with the socket the answer carries", async () => {
    const old = fakePredecessor();
    const predecessor = predecessorOver(old.channel, isServer);
    const socket = new net.Server();
    const taken = predecessor.take("connect");
    expect(old.sent).toEqual([take("connect")]);
    old.answer("connect", socket);
    expect(await taken).toBe(socket);
  });

  it("reports serving and only then ends the channel", () => {
    const old = fakePredecessor();
    predecessorOver(old.channel, isServer).serving();
    expect(old.sent).toEqual([SERVING]);
    expect(old.events).toEqual(["release"]);
  });

  it("rejects a take answered for another listener or without a listening socket, rather than adopting the wrong one", async () => {
    const wrongListener = fakePredecessor();
    const first = predecessorOver(wrongListener.channel, isServer).take("provider");
    wrongListener.answer("direct", new net.Server());
    await expect(first).rejects.toThrow("cannot use");

    const noSocket = fakePredecessor();
    const second = predecessorOver(noSocket.channel, isServer).take("provider");
    noSocket.answer("provider", undefined);
    await expect(second).rejects.toThrow("cannot use");
  });

  it("rejects a pending take, and every later one, once the old door's channel has closed", async () => {
    const old = fakePredecessor();
    const predecessor = predecessorOver(old.channel, isServer);
    const pending = predecessor.take("provider");
    old.close();
    await expect(pending).rejects.toThrow("before it handed over every listener");
    await expect(predecessor.take("connect")).rejects.toThrow("before it handed over the connect listener");
  });
});
