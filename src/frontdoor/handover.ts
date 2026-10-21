import type net from "node:net";
import { z } from "zod";

/**
 * The listening-socket handover between a serving front door and the successor it starts for a planned replacement (`agent-shim frontdoor restart`, `agent-shim update --restart-door`), so the sticky addresses never stop accepting: the kernel's accept queue for each listener is held by the old door until the successor holds it too, and only then does the old door stop accepting and drain.
 *
 * The two doors speak over the IPC channel Node opens between a parent and the child it spawns with one, and each listening socket crosses it as a handle attached to a message (`child.send(message, server)`), which is the only way Node passes a listening socket between processes. The successor asks for each listener only once its own server for that listener is built, and adopts the handle in the same turn the message is delivered in: Node starts accepting on a received listening handle inside a server of its own before it hands the handle over, and a connection accepted there before the successor's server adopts it would reach a server with no connection listener and hang. Asking per listener keeps every adoption inside one delivery.
 *
 * The exchange, in order: the successor sends `take` naming one listener; the old door answers with `listener` naming it and carrying the handle; once the successor has adopted all three and recorded itself as the owner in the state file, it sends `serving` and ends the channel. The old door then drains exactly as it does on `SIGTERM`. Any other outcome (the successor exits or ends the channel early, sends something this release cannot read, or is still not serving when the budget ends) ends the successor if it is still running and leaves the old door to drain the ordinary way, so the replacement still happens, through the path that has a gap.
 */

/** Where a listener's socket comes from: bound afresh, preferring the sticky port and taking any free one when it is held, or adopted from the door being replaced. */
export type ListenSource = { readonly preferredPort: number | undefined } | { readonly inherit: () => Promise<net.Server> };

/** The listeners a door hands over: the HTTPS provider listener, the CONNECT surface, and the plain-HTTP direct listener. */
export const HANDOVER_LISTENERS = ["provider", "connect", "direct"] as const;
export type HandoverListenerName = (typeof HANDOVER_LISTENERS)[number];

/** The version of the messages below. Bumped when a message changes shape, so a door and a successor from different releases recognise a mismatch and fall back to the drain instead of misreading each other. */
export const HANDOVER_MESSAGE_VERSION = 1;

/** Marks a message as this exchange's, since the channel is a general one a host could use for other things. */
const HANDOVER_MESSAGE_KIND = "agent-shim-door-handover";

const ListenerNameSchema = z.enum(HANDOVER_LISTENERS);

/** A successor asking for one listener's handle. */
const TakeMessageSchema = z.strictObject({ kind: z.literal(HANDOVER_MESSAGE_KIND), version: z.literal(HANDOVER_MESSAGE_VERSION), type: z.literal("take"), listener: ListenerNameSchema });
/** The successor reporting that it accepts on every handed-over listener and that the state file names it as the owner. */
const ServingMessageSchema = z.strictObject({ kind: z.literal(HANDOVER_MESSAGE_KIND), version: z.literal(HANDOVER_MESSAGE_VERSION), type: z.literal("serving") });
/** The old door's answer to `take`: the message the listener's handle is attached to. */
const ListenerMessageSchema = z.strictObject({ kind: z.literal(HANDOVER_MESSAGE_KIND), version: z.literal(HANDOVER_MESSAGE_VERSION), type: z.literal("listener"), listener: ListenerNameSchema });

const SuccessorMessageSchema = z.discriminatedUnion("type", [TakeMessageSchema, ServingMessageSchema]);
type SuccessorMessage = z.infer<typeof SuccessorMessageSchema>;
type ListenerMessage = z.infer<typeof ListenerMessageSchema>;

/** The listening sockets a door hands over, one per listener. */
export type HandoverSockets = Readonly<Record<HandoverListenerName, net.Server>>;

/** How a handover ended, as the old door sees it. */
export type HandoverOutcome = { readonly ok: true; readonly successorPid: number } | { readonly ok: false; readonly reason: string };

/** The old door's end of the channel: the successor it spawned. */
export interface SuccessorChannel {
  readonly pid: number;
  /** Sends one message to the successor with a listening socket attached. */
  readonly sendListener: (message: Readonly<ListenerMessage>, socket: net.Server) => void;
  /** Delivers every message the successor sends, unread. */
  readonly onMessage: (listener: (message: unknown) => void) => void;
  /** Fires once when the successor exits or its channel ends, whichever comes first, with a description for the log. */
  readonly onGone: (listener: (description: string) => void) => void;
  /** Ends the channel and stops this process keeping a reference to the successor, so the successor is an ordinary detached door from then on. */
  readonly release: () => void;
  /** Ends the successor outright: used only for one that did not finish taking over. */
  readonly kill: () => void;
}

/** The successor's end of the channel: the door that started it. */
export interface PredecessorChannel {
  /** Sends one message; `sent` runs once it has been written to the channel, which is what lets `release` follow it without cutting it off. */
  readonly send: (message: SuccessorMessage, sent?: () => void) => void;
  /** Delivers every message the old door sends with the handle attached to it, if any, unread; called in the same turn the message is delivered in, which is what lets a listener adopt its handle before anything else runs. */
  readonly onMessage: (listener: (message: unknown, handle: unknown) => void) => void;
  /** Fires once when the channel ends, with a description for the log. */
  readonly onGone: (listener: (description: string) => void) => void;
  /** Ends the channel, so the successor is an ordinary detached door from then on. */
  readonly release: () => void;
}

/** The effects `handOverListeners` needs besides the channel. */
export interface HandoverTimerPorts {
  /** Starts a one-shot timer: `elapsed` resolves when it fires, and `cancel` stops it from ever firing. */
  readonly startTimer: (ms: number) => { readonly elapsed: Promise<void>; readonly cancel: () => void };
}

/**
 * The old door's side of a handover: starts the successor through `spawn`, answers each of its `take` requests with that listener's socket, and resolves once it reports `serving`, or with the reason it did not within `budgetMs`. A successor that did not finish is ended. The sockets stay open and accepting in this process throughout: closing them is the drain's job, and only after this resolves.
 */
export async function handOverListeners(params: { readonly spawn: () => SuccessorChannel; readonly sockets: HandoverSockets; readonly budgetMs: number; readonly timers: HandoverTimerPorts }): Promise<HandoverOutcome> {
  const successor = params.spawn();
  const budget = params.timers.startTimer(params.budgetMs);
  const exchange = new Promise<HandoverOutcome>((resolve) => {
    successor.onGone((description) => {
      resolve({ ok: false, reason: `successor ${String(successor.pid)} ${description} before it was serving` });
    });
    successor.onMessage((raw) => {
      const parsed = SuccessorMessageSchema.safeParse(raw);
      if (!parsed.success) {
        resolve({ ok: false, reason: `successor ${String(successor.pid)} sent a message this door cannot read: ${JSON.stringify(raw)}` });
        return;
      }
      if (parsed.data.type === "serving") {
        resolve({ ok: true, successorPid: successor.pid });
        return;
      }
      const listener = parsed.data.listener;
      successor.sendListener({ kind: HANDOVER_MESSAGE_KIND, version: HANDOVER_MESSAGE_VERSION, type: "listener", listener }, params.sockets[listener]);
    });
  });
  const expired = budget.elapsed.then((): HandoverOutcome => ({ ok: false, reason: `successor ${String(successor.pid)} was not serving within ${String(params.budgetMs)}ms` }));
  // The first outcome decides; the channel is released before another message can be delivered, since nothing but microtasks runs between the decision and the release.
  const outcome = await Promise.race([exchange, expired]);
  budget.cancel();
  if (!outcome.ok) {
    successor.kill();
  }
  successor.release();
  return outcome;
}

/** What a successor door does with the channel to the door it replaces: take each listener's socket, then report that it serves. */
export interface Predecessor {
  /**
   * Asks for one listener's socket and resolves with it in the turn the old door's answer is delivered in, so the caller's continuation (which must adopt it at once, see the module comment) runs before the event loop can accept a connection on it. Rejects when the channel ends first or the answer cannot be read.
   */
  readonly take: (listener: HandoverListenerName) => Promise<net.Server>;
  /** Tells the old door this door accepts on every listener and owns the state file, then ends the channel. */
  readonly serving: () => void;
}

/** The successor's side of a handover over `channel`. `isListeningSocket` decides whether a received handle is the listening socket the answer promises. */
export function predecessorOver(channel: PredecessorChannel, isListeningSocket: (handle: unknown) => handle is net.Server): Predecessor {
  let gone: string | undefined;
  let pending: { readonly listener: HandoverListenerName; readonly resolve: (socket: net.Server) => void; readonly reject: (error: Error) => void } | undefined;
  const failPending = (message: string): void => {
    const waiting = pending;
    pending = undefined;
    waiting?.reject(new Error(message));
  };
  channel.onGone((description) => {
    gone = description;
    failPending(`the replaced door's channel ${description} before it handed over every listener`);
  });
  channel.onMessage((raw, handle) => {
    const parsed = ListenerMessageSchema.safeParse(raw);
    const waiting = pending;
    if (waiting === undefined) {
      // An answer nothing asked for: the old door does not send one, so there is nothing for it to have meant.
      return;
    }
    if (!parsed.success || parsed.data.listener !== waiting.listener || !isListeningSocket(handle)) {
      failPending(`the replaced door sent a handover message this door cannot use: ${JSON.stringify(raw)}`);
      return;
    }
    pending = undefined;
    waiting.resolve(handle);
  });
  return {
    take: async (listener) =>
      await new Promise<net.Server>((resolve, reject) => {
        if (gone !== undefined) {
          reject(new Error(`the replaced door's channel ${gone} before it handed over the ${listener} listener`));
          return;
        }
        pending = { listener, resolve, reject };
        channel.send({ kind: HANDOVER_MESSAGE_KIND, version: HANDOVER_MESSAGE_VERSION, type: "take", listener });
      }),
    serving: () => {
      channel.send({ kind: HANDOVER_MESSAGE_KIND, version: HANDOVER_MESSAGE_VERSION, type: "serving" }, () => {
        channel.release();
      });
    },
  };
}
