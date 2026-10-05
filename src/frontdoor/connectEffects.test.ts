import * as dgram from "node:dgram";
// The module object itself, matching connectEffects' own import: setServers rebinds module.exports' resolve functions, so redirecting the door's name dials at this file's stand-in only reaches code that reads the binding live.
import dns from "node:dns";
import * as http from "node:http";
import * as net from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExemptHttpAgent, realConnectEffects, SourcePortRange } from "./connectEffects";
import { HTTP_OK } from "./connectTestWorld";

/** The name every dial in this file resolves: a documentation-reserved TLD, so nothing but this file's resolver stand-in can ever answer it, and a dial through the exempt agent takes the real-name path (reserved source port, DNS lookup) rather than the address-literal shortcut. */
const DIAL_NAME = "reserved-range-test.invalid";

/** How many of the range's ports the retry test holds before the dial under test: enough to prove the dial walks past several held ports, few enough to leave the range mostly free. */
const HELD_PORTS = 3;

/** The first port of the private range every test in this file dials from: just above the door's own range, which no other test file dials from either, so pinning every port of it cannot race another worker for the door's real range. */
const PRIVATE_RANGE_START = 47920;

/** How many of the private range's ports stay free for the retry test's dial to land on after the held ones. */
const FREE_PORTS_TO_RETRY_ONTO = 3;

/** The private range's width: a few more ports than the retry test holds, so the dial has free ports to retry onto. */
const PRIVATE_RANGE_WIDTH = HELD_PORTS + FREE_PORTS_TO_RETRY_ONTO;

/** The range every dial in this file draws its source ports from, one rotation shared across the file's agents the way the door's own shares its range. */
const PRIVATE_RANGE = new SourcePortRange(PRIVATE_RANGE_START, PRIVATE_RANGE_START + PRIVATE_RANGE_WIDTH - 1);

/** The bind-phase errnos the retried dial must surface when it cannot: EADDRINUSE on most platforms, and the EADDRNOTAVAIL a held port produced in the live observation. */
const HELD_PORT_ERRNOS: ReadonlySet<string> = new Set(["EADDRINUSE", "EADDRNOTAVAIL"]);

/** The loopback address the resolver stand-in hands out and the pins dial, as octets for the DNS answer wire. */
const LOOPBACK_OCTETS = "127.0.0.1".split(".").map((part) => Number(part));

/** A DNS message's fixed header, in bytes: the offset both the question walk and the answer's name pointer start from. */
const DNS_HEADER_LENGTH = 12;
/** What follows a question's terminating null label: the label byte itself plus the type and class fields. */
const DNS_QUESTION_TAIL_LENGTH = 5;
/** The answer-header bits that mark a response, authoritative, echoing the query's recursion-desired bit. */
const DNS_FLAG_RESPONSE = 0x80;
const DNS_FLAG_AUTHORITATIVE = 0x04;
const DNS_FLAG_RECURSION_DESIRED = 0x01;
/** The answer-header bit that says recursion is available, which c-ares expects of a resolver. */
const DNS_FLAG_RECURSION_AVAILABLE = 0x80;
/** The top bits that mark a DNS name as a compression pointer rather than a label sequence. */
const DNS_NAME_POINTER_TAG = 0xc0;
/** The answer's own fields: an A record of class IN, held long enough that no expiry logic can fire mid-test. */
const DNS_TYPE_A = 1;
const DNS_CLASS_IN = 1;
const DNS_STAND_IN_TTL_SECONDS = 60;
const DNS_IPV4_OCTETS = 4;

/** The port `steps` ahead of `from` in the reserved range, wrapping with the range the way the rotation itself does. */
function reservedPortAhead(from: number, steps: number): number {
  return PRIVATE_RANGE.start + ((from - PRIVATE_RANGE.start + steps) % PRIVATE_RANGE.count);
}

/** The offset just past a DNS query's question section, which is where an answer's own records begin. */
function questionEnd(query: Buffer): number {
  let offset = DNS_HEADER_LENGTH;
  while ((query[offset] ?? 0) !== 0) {
    offset += (query[offset] ?? 0) + 1;
  }
  return offset + DNS_QUESTION_TAIL_LENGTH;
}

/** Starts the stand-in upstream every dial in a test targets, recording the source port each request arrives from: the stand-in's own view of the source port is what proves which reserved port a dial took and which it skipped. */
async function startUpstream(): Promise<{ readonly port: number; readonly arrivals: readonly number[]; readonly close: () => Promise<void> }> {
  const arrivals: number[] = [];
  const server = http.createServer((request, response) => {
    const sourcePort = request.socket.remotePort;
    if (sourcePort !== undefined) {
      arrivals.push(sourcePort);
    }
    const body = "stand-in-answer";
    response.writeHead(HTTP_OK, { "content-type": "text/plain", "content-length": String(body.length) });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the stand-in upstream did not bind a TCP port");
  }
  return {
    port: bound.port,
    arrivals,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
      });
    },
  };
}

/** Performs one real request through a fresh exempt agent against the stand-in, resolving with the answer body and the source port the request left from. */
async function requestThrough(port: number): Promise<{ readonly body: string; readonly sourcePort: number }> {
  return await new Promise((resolve, reject) => {
    const request = http.request({ host: DIAL_NAME, port, method: "GET", path: "/", agent: new ExemptHttpAgent(PRIVATE_RANGE) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        // The client side of the same socket: its local port is the source port the stand-in saw.
        const sourcePort = response.socket.localPort;
        if (sourcePort === undefined) {
          reject(new Error("the client socket did not report its local port"));
          return;
        }
        resolve({ body: Buffer.concat(chunks).toString("utf8"), sourcePort });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

/** Holds one reserved port the way the door's own dials bind it: a wildcard-bound socket connected to the stand-in and kept open, the shape of the live failure (a long-lived sibling to the same destination holding a port of the range). Resolves undefined for a port that was already in use before it could be held. */
async function holdReservedPort(port: number, upstreamPort: number): Promise<net.Socket | undefined> {
  return await new Promise((resolve, reject) => {
    const held = net.connect({ host: "127.0.0.1", port: upstreamPort, localPort: port });
    held.once("connect", () => {
      resolve(held);
    });
    held.once("error", (error: NodeJS.ErrnoException) => {
      // A port that is already unbindable (a sibling's socket, or the TIME_WAIT an earlier dial left on it, which Linux enforces on bind) fails the door's own dial with the same EADDRINUSE, so it is as held as one this helper holds itself.
      if (error.code === "EADDRINUSE") {
        resolve(undefined);
        return;
      }
      reject(error);
    });
  });
}

/** Performs one request and captures the errno of the failure it settles with instead of the answer, so the assertion reads the dial's own error code; undefined when the failure carried none. */
async function requestFailureCode(port: number): Promise<string | undefined> {
  return await requestThrough(port).then(
    () => {
      throw new Error("a held range unexpectedly served the request");
    },
    (error: unknown) => {
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        return error.code;
      }
      return undefined;
    },
  );
}

describe("the exempt agents' reserved source-port rotation", () => {
  let resolver: dgram.Socket;
  const realServers = dns.getServers();

  beforeAll(async () => {
    resolver = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => {
      resolver.bind(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const bound = resolver.address();
    resolver.on("message", (query, from) => {
      // One A answer naming loopback, echoing the query's own question back: the header keeps the query's id and question count, and the answer points at the question by compression pointer.
      const header = Buffer.from([
        query[0] ?? 0,
        query[1] ?? 0,
        DNS_FLAG_RESPONSE | DNS_FLAG_AUTHORITATIVE | DNS_FLAG_RECURSION_DESIRED,
        DNS_FLAG_RECURSION_AVAILABLE,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0,
      ]);
      const question = query.subarray(DNS_HEADER_LENGTH, questionEnd(query));
      const answer = Buffer.from([DNS_NAME_POINTER_TAG, DNS_HEADER_LENGTH, 0, DNS_TYPE_A, 0, DNS_CLASS_IN, 0, 0, 0, DNS_STAND_IN_TTL_SECONDS, 0, DNS_IPV4_OCTETS, ...LOOPBACK_OCTETS]);
      resolver.send(Buffer.concat([header, question, answer]), from.port, from.address);
    });
    // The door's own dials resolve names through dns.resolve4, so pointing node's own resolver at the stand-in is what routes a name dial at this machine while still running the real lookup path.
    dns.setServers([`127.0.0.1:${String(bound.port)}`]);
  });

  afterAll(async () => {
    dns.setServers(realServers);
    await new Promise<void>((resolve) => {
      resolver.close(() => {
        resolve(undefined);
      });
    });
  });

  it("retries a dial whose reserved port is held on the next port of the range", async () => {
    const upstream = await startUpstream();
    const held: net.Socket[] = [];
    try {
      // The discovery request names the rotation's current position, wherever earlier dials in this process left it, so the held ports below are exactly the next ones the retrying dial would take.
      const discovery = await requestThrough(upstream.port);
      expect(discovery.body).toBe("stand-in-answer");
      expect(discovery.sourcePort).toBeGreaterThanOrEqual(PRIVATE_RANGE.start);
      expect(discovery.sourcePort).toBeLessThanOrEqual(PRIVATE_RANGE.end);

      try {
        const heldPorts = new Set<number>();
        for (let step = 1; step <= HELD_PORTS; step += 1) {
          const port = reservedPortAhead(discovery.sourcePort, step);
          heldPorts.add(port);
          const socket = await holdReservedPort(port, upstream.port);
        if (socket !== undefined) {
          held.push(socket);
        }
        }
        const retried = await requestThrough(upstream.port);
        expect(retried.body).toBe("stand-in-answer");
        expect(retried.sourcePort).toBeGreaterThanOrEqual(PRIVATE_RANGE.start);
        expect(retried.sourcePort).toBeLessThanOrEqual(PRIVATE_RANGE.end);
        expect(retried.sourcePort).not.toBe(discovery.sourcePort);
        // The retried dial skipped the held ports: the request left from a reserved source port outside the held set.
        expect(heldPorts.has(retried.sourcePort)).toBe(false);
      } finally {
        for (const socket of held) {
          socket.destroy();
        }
      }
    } finally {
      await upstream.close();
    }
  });

  it("surfaces the bind error when every port of the range is held", async () => {
    const upstream = await startUpstream();
    const held: net.Socket[] = [];
    try {
      for (let port = PRIVATE_RANGE.start; port <= PRIVATE_RANGE.end; port += 1) {
        const socket = await holdReservedPort(port, upstream.port);
        if (socket !== undefined) {
          held.push(socket);
        }
      }
      const failureCode = await requestFailureCode(upstream.port);
      expect(failureCode !== undefined && HELD_PORT_ERRNOS.has(failureCode)).toBe(true);
      // No dial of the fully-held range ever connected, so the stand-in saw no request at all.
      expect(upstream.arrivals).toHaveLength(0);
    } finally {
      for (const socket of held) {
        socket.destroy();
      }
      await upstream.close();
    }
  });
  it("surfaces the bind error from a tap session's upstream dial when every port of the range is held, instead of redialling forever", async () => {
    const upstream = await startUpstream();
    const held: net.Socket[] = [];
    try {
      for (let port = PRIVATE_RANGE.start; port <= PRIVATE_RANGE.end; port += 1) {
        const socket = await holdReservedPort(port, upstream.port);
        if (socket !== undefined) {
          held.push(socket);
        }
      }
      const failureCode = await realConnectEffects(PRIVATE_RANGE)
        .connectTlsUpstream(DIAL_NAME, upstream.port, undefined)
        .then(
          () => {
            throw new Error("a held range unexpectedly served the tap's upstream dial");
          },
          (error: unknown) => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined),
        );
      expect(failureCode !== undefined && HELD_PORT_ERRNOS.has(failureCode)).toBe(true);
      expect(upstream.arrivals).toHaveLength(0);
    } finally {
      for (const socket of held) {
        socket.destroy();
      }
      await upstream.close();
    }
  });
});
