import net from "node:net";
import { describe, expect, it } from "vitest";

import { inodeOfLocalPort, parentTable, peerProcessOf, pidHoldingLocalPort } from "./peerProcess";

/** Made-up pids and ports for the parsing cases. */
const DOOR_PID = 100;
const CLIENT_PID = 200;
const CLIENT_PORT = 51000;
const LISTENER_PORT = 47000;
/** `/proc/net/tcp` writes ports in hexadecimal. */
const HEX_RADIX = 16;

describe("reading the process that holds a loopback connection's client end", () => {
  it("picks the lsof entry whose own address carries the port, never the door's accepted end naming it as remote", () => {
    const fields = [`p${String(DOOR_PID)}`, "f10", `n127.0.0.1:${String(LISTENER_PORT)}->127.0.0.1:${String(CLIENT_PORT)}`, `p${String(CLIENT_PID)}`, "f3", `n127.0.0.1:${String(CLIENT_PORT)}->127.0.0.1:${String(LISTENER_PORT)}`].join("\n");
    expect(pidHoldingLocalPort(fields, CLIENT_PORT)).toBe(CLIENT_PID);
    expect(pidHoldingLocalPort(fields, CLIENT_PORT + 1)).toBeUndefined();
  });

  it("reads the established socket's inode from /proc/net/tcp by its hexadecimal local port", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      `   0: 0100007F:${LISTENER_PORT.toString(HEX_RADIX).toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1111 1 0`,
      `   1: 0100007F:${CLIENT_PORT.toString(HEX_RADIX).toUpperCase()} 0100007F:${LISTENER_PORT.toString(HEX_RADIX).toUpperCase()} 01 00000000:00000000 00:00000000 00000000  1000        0 2222 1 0`,
    ].join("\n");
    expect(inodeOfLocalPort(table, CLIENT_PORT)).toBe("2222");
    expect(inodeOfLocalPort(table, LISTENER_PORT)).toBeUndefined();
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")("finds this process as the holder of a loopback connection it opened, and its parent in the table", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the listener reported no port");
    }
    const client = net.connect(address.port, "127.0.0.1");
    await new Promise<void>((resolve) => {
      client.once("connect", () => {
        resolve();
      });
    });
    try {
      expect(await peerProcessOf(client.localPort ?? 0)).toBe(process.pid);
      expect((await parentTable())?.get(process.pid)).toBe(process.ppid);
    } finally {
      client.destroy();
      server.close();
    }
  });
});
