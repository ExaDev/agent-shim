import { EventEmitter } from "node:events";

import type { DialSocket, DoorDialIo } from "./doorDial";
import { sourcePortClassifier } from "./doorDial";

/** A socket that never connects and records what is done to it: the stand-in for a host that never answers the SYN. */
export class SilentSocket extends EventEmitter implements DialSocket {
  writes = 0;
  destroyed = false;

  write(): boolean {
    this.writes += 1;
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

/** The classification the dial is given for `platform`, as the door builds it from `process.platform`. */
export function unusableOn(platform: string): DoorDialIo<SilentSocket>["sourcePortFailure"] {
  return sourcePortClassifier(platform);
}

export type DialOptions = Parameters<DoorDialIo<SilentSocket>["connect"]>[0];

/** A `connect` whose sockets answer from a script, recording the options of every dial: each dial takes the next entry, an error code to fail with or `undefined` to connect. */
export function scriptedDials(script: readonly (string | undefined)[]): { readonly connect: DoorDialIo<SilentSocket>["connect"]; readonly dialled: readonly DialOptions[] } {
  const dialled: DialOptions[] = [];
  return {
    dialled,
    connect: (options) => {
      const code = script[dialled.length];
      dialled.push(options);
      const socket = new SilentSocket();
      queueMicrotask(() => {
        if (code === undefined) {
          socket.emit("connect");
          return;
        }
        if (code.startsWith("AGG:")) {
          const attempts = code.slice("AGG:".length).split("|").map((attempt) => {
            const [errno, syscall] = attempt.split("@");
            const sub: NodeJS.ErrnoException = new Error(attempt);
            sub.code = errno;
            sub.syscall = syscall;
            return sub;
          });
          const aggregate: NodeJS.ErrnoException = new AggregateError(attempts, "");
          aggregate.code = attempts[0]?.code;
          socket.emit("error", aggregate);
          return;
        }
        // `CODE@syscall` names the syscall node reports the failure from (`bind` for a source port that cannot be bound, `connect` for the destination), as node does.
        const [errno, syscall] = code.split("@");
        const failure: NodeJS.ErrnoException = new Error(`dial failed with ${errno ?? code}`);
        failure.code = errno ?? code;
        if (syscall !== undefined) {
          failure.syscall = syscall;
        }
        socket.emit("error", failure);
      });
      return socket;
    },
  };
}
