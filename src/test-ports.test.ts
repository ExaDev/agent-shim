import * as net from "node:net";
import { describe, expect, it } from "vitest";

import { closedLoopbackPort, refusesConnections } from "./test-ports";

const LOOPBACK = "127.0.0.1";
const FIRST_EPHEMERAL_PORT = 32_768;
const FIRST_CANDIDATE_PORT = 20_000;

async function refused(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = net.connect({ host: LOOPBACK, port });
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => {
      resolve(true);
    });
  });
}

describe("a closed loopback port", () => {
  it("is below the range the operating system assigns to listeners bound on port 0, and refuses a connection", async () => {
    let drawnTo = 0;
    const port = await closedLoopbackPort((from, to) => {
      drawnTo = to;
      return from;
    });
    expect(drawnTo).toBe(FIRST_EPHEMERAL_PORT);
    expect(port).toBeLessThan(FIRST_EPHEMERAL_PORT);
    expect(await refused(port)).toBe(true);
  });

  it("skips a candidate something listens on and takes another that refuses", async () => {
    const taken = await closedLoopbackPort();
    const holder = net.createServer();
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(taken, LOOPBACK, resolve);
    });
    try {
      const next = await closedLoopbackPort(() => taken);
      expect(next).not.toBe(taken);
      expect(await refused(next)).toBe(true);
    } finally {
      holder.close();
    }
  });

  /** Makes `port` busy for the test: bound here, or already held by something else, which is as busy. Returns what releases it. */
  async function occupy(port: number): Promise<() => void> {
    const holder = net.createServer();
    const bound = await new Promise<boolean>((resolve) => {
      holder.once("error", () => {
        resolve(false);
      });
      holder.listen(port, LOOPBACK, () => {
        resolve(true);
      });
    });
    return () => {
      if (bound) {
        holder.close();
      }
    };
  }

  it("moves on from a busy first candidate to the next one up, never to one below the range", async () => {
    const release = await occupy(FIRST_CANDIDATE_PORT);
    try {
      const port = await closedLoopbackPort((from) => from);
      expect(port).toBeGreaterThan(FIRST_CANDIDATE_PORT);
      expect(await refused(port)).toBe(true);
    } finally {
      release();
    }
  });

  it("wraps from a busy last candidate to the first of the range", async () => {
    const release = await occupy(FIRST_EPHEMERAL_PORT - 1);
    try {
      const port = await closedLoopbackPort((_from, to) => to - 1);
      expect(port).toBeGreaterThanOrEqual(FIRST_CANDIDATE_PORT);
      expect(port).toBeLessThan(FIRST_EPHEMERAL_PORT - 1);
      expect(await refused(port)).toBe(true);
    } finally {
      release();
    }
  });

  it("tries every candidate of the range, the last one included, and throws when none refuses", async () => {
    const tried: number[] = [];
    const port = await closedLoopbackPort(() => FIRST_CANDIDATE_PORT, async (candidate) => {
      tried.push(candidate);
      return await Promise.resolve(candidate === FIRST_EPHEMERAL_PORT - 1);
    });
    expect(port).toBe(FIRST_EPHEMERAL_PORT - 1);
    expect(tried).toHaveLength(FIRST_EPHEMERAL_PORT - FIRST_CANDIDATE_PORT);
    expect(tried[0]).toBe(FIRST_CANDIDATE_PORT);
    await expect(closedLoopbackPort(() => FIRST_CANDIDATE_PORT, async () => await Promise.resolve(false))).rejects.toThrow(/refused a connection/);
  });

  it.each([["ECONNREFUSED", true], ["ETIMEDOUT", false], ["ECONNRESET", false]])("takes a connect that fails with %s as refusing (%s)", async (code, refusing) => {
    const failing = (): net.Socket => {
      const socket = new net.Socket();
      queueMicrotask(() => {
        const error: NodeJS.ErrnoException = new Error(code);
        error.code = code;
        socket.emit("error", error);
      });
      return socket;
    };
    expect(await refusesConnections(FIRST_CANDIDATE_PORT, failing)).toBe(refusing);
  });
});
