import { randomInt } from "node:crypto";
import * as net from "node:net";

/**
 * The lowest port the default ephemeral range of the systems the tests run on starts at: Linux at 32768, macOS and Windows at 49152. On a system whose range starts at or above it, a bind to port 0 is never given a port below it; a machine configured with a lower range (`net.ipv4.ip_local_port_range` on Linux) loses that for the ports it adds, and the connect check in `closedLoopbackPort` then holds only for the moment it is made.
 */
const FIRST_EPHEMERAL_PORT = 32_768;

/** The lowest port a candidate is drawn from. The candidates lie in the registered range (1024 to 49151) below every ephemeral range, where few services listen, and the connect check skips any that does. */
const FIRST_CANDIDATE_PORT = 20_000;

const LOOPBACK = "127.0.0.1";

/** What `refusesConnections` needs of the network: a socket to the loopback address on `port`. */
export type ConnectPort = (options: Readonly<{ readonly host: string; readonly port: number }>) => net.Socket;

/** Whether a TCP connect to `port` on the loopback address is refused at once, which is what a port nothing listens on answers. `connect` is injectable so a test can steer the answer: any other error, such as a timeout, says nothing about the port being free. */
export async function refusesConnections(port: number, connect: ConnectPort = (options) => net.connect({ host: options.host, port: options.port })): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = connect({ host: LOOPBACK, port });
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ECONNREFUSED");
    });
  });
}

/**
 * A loopback port that refuses connections, for a test of what a caller does when its upstream is down, or a port a test will bind a listener on later. A port bound on port 0 and released can be handed to another test's listener in the gap before it is used, and the caller then reaches that listener (a 401 where a refused connect was expected) or fails to bind it. This one is drawn from below the range the system assigns to listeners bound on port 0 and checked to refuse a connection, so it is free now and no listener bound on port 0 can take it. What is left is a process that binds that exact port by name in the gap, which is a service that happens to start there and not another test: tests bind port 0 or take their port from here. `draw` picks the first candidate in `[from, to)` and `refuses` decides whether a candidate refuses a connection; both are injectable so a test can steer the draw and the answer. Throws when every candidate in the range was tried and none refused a connection.
 */
export async function closedLoopbackPort(draw: (from: number, to: number) => number = randomInt, refuses: (port: number) => Promise<boolean> = refusesConnections): Promise<number> {
  const span = FIRST_EPHEMERAL_PORT - FIRST_CANDIDATE_PORT;
  const start = draw(FIRST_CANDIDATE_PORT, FIRST_EPHEMERAL_PORT) - FIRST_CANDIDATE_PORT;
  for (let offset = 0; offset < span; offset += 1) {
    const candidate = FIRST_CANDIDATE_PORT + ((start + offset) % span);
    if (await refuses(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no loopback port in [${String(FIRST_CANDIDATE_PORT)}, ${String(FIRST_EPHEMERAL_PORT)}) refused a connection`);
}
