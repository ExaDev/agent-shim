import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";

import { parseDialAuthority } from "../baseUrlDial";

/**
 * Which local process holds the other end of a loopback TCP connection, and which process started which: what lets the front door attribute a connection that arrived by an operating-system redirect (and so carries no launch capability) to the launch it belongs to. Every lookup is asynchronous, because the door's event loop answers every session.
 *
 * Darwin reads the socket table through `lsof`; Linux reads `/proc/net/tcp` and `/proc/net/tcp6` for the socket's inode and then the `/proc/<pid>/fd` links for the process holding it. Any other platform, a lookup that fails, or a connection no process holds any more, answers undefined: the caller decides what an unattributable connection means.
 */

/** `/proc/net/tcp` writes ports as four hexadecimal digits. */
const HEX_RADIX = 16;
const HEX_PORT_WIDTH = 4;
/** The columns of a `/proc/net/tcp` row this module reads: the local address, the connection state and the socket inode. */
const PROC_NET_LOCAL_FIELD = 1;
const PROC_NET_STATE_FIELD = 3;
const PROC_NET_INODE_FIELD = 9;
/** The state code of an established connection in `/proc/net/tcp`. */
const PROC_NET_ESTABLISHED = "01";

/** Runs one command and resolves its standard output, or undefined when it cannot run or exits unsuccessfully. */
async function outputOf(command: string, args: readonly string[]): Promise<string | undefined> {
  return await new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout) => {
      resolve(error === null ? stdout : undefined);
    });
  });
}

/** The port an endpoint without one is read as: port 0 is never a connection's, so it stands for none. */
const NO_PORT = 0;

/** The port of one `host:port` endpoint as lsof prints it (IPv6 bracketed), or undefined when it names none or cannot be read. */
function portOf(endpoint: string): number | undefined {
  const parsed = parseDialAuthority(endpoint, NO_PORT);
  return "refusal" in parsed || parsed.port === NO_PORT ? undefined : parsed.port;
}

/**
 * The pid in `lsof -F pn` output whose socket's local end is on `port`: lsof lists both ends of a loopback connection (this door's accepted socket names the same port as its remote end), so only the entry whose own address carries the port is the client's.
 */
export function pidHoldingLocalPort(lsofFields: string, port: number): number | undefined {
  let pid: number | undefined;
  for (const line of lsofFields.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid !== undefined) {
      const [local] = line.slice(1).split("->");
      if (local !== undefined && portOf(local) === port) {
        return pid;
      }
    }
  }
  return undefined;
}

/** The inode of the established socket whose local port is `port`, from the rows of `/proc/net/tcp` or `/proc/net/tcp6` (address and port in hexadecimal, state `01` meaning established). */
export function inodeOfLocalPort(procNetTcp: string, port: number): string | undefined {
  const hexPort = port.toString(HEX_RADIX).toUpperCase().padStart(HEX_PORT_WIDTH, "0");
  for (const row of procNetTcp.split("\n").slice(1)) {
    const fields = row.trim().split(/\s+/);
    const local = fields[PROC_NET_LOCAL_FIELD];
    if (local?.endsWith(`:${hexPort}`) === true && fields[PROC_NET_STATE_FIELD] === PROC_NET_ESTABLISHED) {
      return fields[PROC_NET_INODE_FIELD];
    }
  }
  return undefined;
}

async function linuxPeerProcess(port: number): Promise<number | undefined> {
  const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map(async (file) => await fsp.readFile(file, "utf8").catch(() => "")));
  const inode = tables.map((table) => inodeOfLocalPort(table, port)).find((found) => found !== undefined);
  if (inode === undefined || inode === "0") {
    return undefined;
  }
  const target = `socket:[${inode}]`;
  for (const entry of await fsp.readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const fds = await fsp.readdir(`/proc/${entry}/fd`).catch(() => []);
    for (const fd of fds) {
      if ((await fsp.readlink(`/proc/${entry}/fd/${fd}`).catch(() => "")) === target) {
        return Number(entry);
      }
    }
  }
  return undefined;
}

/** The pid of the local process whose TCP socket has `port` as its local port, or undefined when it cannot be read on this platform or no process holds it. */
export async function peerProcessOf(port: number): Promise<number | undefined> {
  if (process.platform === "darwin") {
    const fields = await outputOf("lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:ESTABLISHED", "-F", "pn"]);
    return fields === undefined ? undefined : pidHoldingLocalPort(fields, port);
  }
  if (process.platform === "linux") {
    return await linuxPeerProcess(port);
  }
  return undefined;
}

/** Every process's parent, from `ps`, or undefined when the table cannot be read. */
export async function parentTable(): Promise<ReadonlyMap<number, number> | undefined> {
  const table = await outputOf("ps", ["-A", "-o", "pid=,ppid="]);
  if (table === undefined) {
    return undefined;
  }
  const parents = new Map<number, number>();
  for (const line of table.split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && parent !== undefined && Number.isInteger(pid) && Number.isInteger(parent)) {
      parents.set(pid, parent);
    }
  }
  return parents;
}
