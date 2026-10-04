import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import * as net from "node:net";
import * as tls from "node:tls";

import { CONNECT_INTERCEPT_HOST, HTTPS_PORT, HTTP_BAD_GATEWAY, forwardableHeaders, type ConnectEffects, type ConnectListenerHandle } from "./connect";
import type { RcDialAnswer, RcEventDial } from "./rcSessions";

/** The real `ConnectEffects` over node's own net, tls, and http. `connectTcp` opens real connections to the CONNECTed host, so tests that want a blind tunnel redirect it. */
/**
 * A DNS lookup for the door's own upstream dials that bypasses the hosts file, because a transparent-interception deployment points the intercept hosts' names at this machine in /etc/hosts: getaddrinfo (Node's default lookup) would send the door's own upstream connections straight back into the intercept port, a loop, while `dns.resolve4` asks the resolver directly and returns the real address. The SNI and Host stay the real name; only the dial address comes from DNS.
 */

/**
 * The local source-port range the door's own upstream sockets bind, matching the pf exemption an interception deployment loads alongside the redirect: without it, the door's dial to the real address would be redirected straight back into its own transparent surface, an endless loop. Node binds one port per socket with no range option, so this hands them out in rotation and a dial that loses the race to a still-closing socket retries on the next port.
 */
const UPSTREAM_LOCAL_PORT_START = 47900;
const UPSTREAM_LOCAL_PORT_END = 47919;
let nextUpstreamLocalPort = UPSTREAM_LOCAL_PORT_START;

/** The next source port for one of the door's own upstream dials, in rotation. */
function upstreamLocalPort(): number {
  const port = nextUpstreamLocalPort;
  nextUpstreamLocalPort = nextUpstreamLocalPort === UPSTREAM_LOCAL_PORT_END ? UPSTREAM_LOCAL_PORT_START : nextUpstreamLocalPort + 1;
  return port;
}

const realAddressLookup: LookupFunction = (host, _options, callback) => {
  // An address literal is not a name to resolve; resolve4 would query DNS for it as a hostname and fail. Hand it straight back, so a loopback or otherwise-literal upstream (every test's local fake, and any loopback provider) keeps working under this lookup.
  if (net.isIP(host) !== 0) {
    callback(null, [{ address: host, family: net.isIP(host) }]);
    return;
  }
  dns.resolve4(host, (error, addresses) => {
    const first = addresses[0];
    if (error !== null || first === undefined) {
      callback(error ?? new Error(`no A record for ${host}`), [{ address: "", family: 4 }]);
      return;
    }
    callback(null, [{ address: first, family: 4 }]);
  });
};

/** The default port a plain-HTTP dial lands on when the request names none. */
const HTTP_PORT = 80;

/**
 * Builds one raw socket for the door's own upstream dials: bound into the reserved source-port range and resolved through real DNS for a real name (the pf-exemption counterparts, keeping a redirected address's traffic from looping into the door's own transparent surface), and dialled exactly as node's own agents would for an address literal, which no redirect can name.
 */
function exemptDial(options: http.ClientRequestArgs, defaultPort: number): net.Socket {
  const host = typeof options.host === "string" ? options.host : "";
  const port = typeof options.port === "number" ? options.port : defaultPort;
  return net.connect(net.isIP(host) === 0 ? { host, port, localPort: upstreamLocalPort(), lookup: realAddressLookup } : { host, port });
}

/**
 * The request's own servername (which a forwarding target may set to the real host it stands in for) outranks the dial address: presenting the dial address instead would fail the handshake against a stand-in whose certificate names the real host.
 */
function requestServername(options: http.ClientRequestArgs, fallback: string): string {
  return "servername" in options && typeof options.servername === "string" && options.servername !== "" ? options.servername : fallback;
}

/** The plain-HTTP sibling; http.Agent and https.Agent each carry their protocol, and one cannot serve the other's requests. */
export class ExemptHttpAgent extends http.Agent {
  createConnection(options: http.ClientRequestArgs): net.Socket {
    return exemptDial(options, HTTP_PORT);
  }
}

/** The TLS sibling: the door's keep-alive agent for https upstreams, every real-name socket in the pf-exempt source-port range. */
export class ExemptTlsAgent extends https.Agent {
  createConnection(options: http.ClientRequestArgs): net.Socket {
    const host = typeof options.host === "string" ? options.host : "";
    // The request's own TLS facts ride in the options (a forwarding target's servername, its trust anchors for a stand-in upstream, its verification stance): node's own agent consumes them, so this one must too.
    const tlsOptions: tls.ConnectionOptions = { socket: exemptDial(options, HTTPS_PORT), servername: requestServername(options, host) };
    if ("ca" in options && Array.isArray(options.ca)) {
      tlsOptions.ca = options.ca;
    }
    if ("rejectUnauthorized" in options && typeof options.rejectUnauthorized === "boolean") {
      tlsOptions.rejectUnauthorized = options.rejectUnauthorized;
    }
    return tls.connect(tlsOptions);
  }
}

/** Where the Remote Control inject path dials: the API host's own address by default, over TLS with the door's interception-proof agent (real-name DNS resolution and the pf-exempt source-port range), so an injected event cannot be looped back into the door's own transparent surface. A test redirects the dial at a local stand-in presenting the host's name, exactly as the forwarding targets are redirected. */
export interface RcDialTarget {
  readonly host: string;
  readonly port: number;
  /** The SNI name to present; defaults to `host`. */
  readonly servername?: string;
  /** Extra trust anchors for a stand-in's certificate, when it is not system-trusted. */
  readonly ca?: readonly string[];
  /** Overrides certificate verification; production leaves it at the Node default. */
  readonly rejectUnauthorized?: boolean;
}

/**
 * The real `RcEventDial`: one keep-alive TLS agent of the door's own exempt kind, so every injected event rides the same interception-proof dials the door's forwarded traffic does. The dial only ever reads small JSON answers (an event write's result, or an error), never a stream.
 */
export function realRcEventDial(target: RcDialTarget = { host: CONNECT_INTERCEPT_HOST, port: HTTPS_PORT }): RcEventDial {
  const agent = new ExemptTlsAgent();
  return {
    writeEvents: async (sessionId, headers, body) =>
      await new Promise<RcDialAnswer>((resolve, reject) => {
        const options: https.RequestOptions = {
          host: target.host,
          port: target.port,
          method: "POST",
          path: `/v1/code/sessions/${encodeURIComponent(sessionId)}/events`,
          // The Host header names the host whose API this is, not the address dialled: a redirected test dials a loopback stand-in while still speaking to the API host by name, exactly as the forwarded paths present their SNI.
          headers: { ...headers, host: target.servername ?? target.host, "content-length": String(Buffer.byteLength(body, "utf8")) },
          agent,
        };
        // The request's own TLS facts ride in the options (a stand-in's servername, its trust anchors, its verification stance), exactly as the forwarding target's do.
        options.servername = target.servername ?? target.host;
        if (target.ca !== undefined) {
          options.ca = [...target.ca];
        }
        if (target.rejectUnauthorized !== undefined) {
          options.rejectUnauthorized = target.rejectUnauthorized;
        }
        const request = https.request(options, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on("end", () => {
            resolve({ status: response.statusCode ?? HTTP_BAD_GATEWAY, body: Buffer.concat(chunks).toString("utf8") });
          });
        });
        request.once("error", reject);
        request.end(body);
      }),
  };
}

export function realConnectEffects(): ConnectEffects {
  // Keep-alive on both agents so a client reusing its TLS session gets its forwarded requests served over reused upstream connections too, the way a direct connection would, with every socket in the door's pf-exempt source-port range.
  const plainAgent = new ExemptHttpAgent();
  const tlsAgent = new ExemptTlsAgent();

  const listenOnce = async (port: number, onSocket: (socket: net.Socket) => void): Promise<ConnectListenerHandle> =>
    await new Promise((resolve, reject) => {
      const accepted = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        accepted.add(socket);
        socket.on("close", () => {
          accepted.delete(socket);
        });
        onSocket(socket);
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        // A listening TCP server's address is always the object form; the string form is for pipes and unix sockets only.
        const bound = typeof address === "object" && address !== null ? address.port : 0;
        if (bound === 0) {
          reject(new Error("could not bind a loopback port"));
          return;
        }
        resolve({
          port: bound,
          close: async () => {
            await new Promise<void>((closeResolve) => {
              // Stop accepting first (synchronous in the closing flag it sets, so no further connection callback can run and grow `accepted` afterwards), then end everything this listener handed out, which is what lets close's own callback fire.
              server.close(() => {
                closeResolve(undefined);
              });
              for (const socket of accepted) {
                socket.destroy();
              }
            });
          },
        });
      });
    });

  return {
    listenLoopback: async (preferredPort, onSocket) => {
      if (preferredPort !== undefined) {
        try {
          return await listenOnce(preferredPort, onSocket);
        } catch {
          // The sticky port was taken between generations; any free port will do, and the supervisor logs the move.
        }
      }
      return await listenOnce(0, onSocket);
    },
    createTlsAcceptor: (leaf, onSecure, alpnProtocols) => {
      // The context `accept` was last called with, read inside the same synchronous stack as the handshake's connection event, so each session receives exactly its own connection's context with no interleaving.
      let pendingContext = "";
      const server = tls.createServer(
        { key: leaf.keyPem, cert: leaf.certPem, ...(alpnProtocols === undefined ? {} : { ALPNProtocols: [...alpnProtocols] }) },
        (secure) => {
          onSecure(secure, pendingContext);
        },
      );
      // A failed handshake (a client that does not trust the CA, or speaks no TLS) surfaces here; the only honest response is to drop the connection.
      server.on("clientError", (_error: Error, socket: net.Socket) => {
        socket.destroy();
      });
      return {
        // tls.Server is a net.Server whose connection listener wraps the raw socket in the TLS handshake, and emitting the event by hand is what runs that listener on a socket this process already owns (the CONNECT half of the connection) rather than one the server accepted itself.
        accept: (socket, context) => {
          pendingContext = context;
          server.emit("connection", socket);
        },
        close: () => {
          server.close();
        },
      };
    },
    createSniTlsAcceptor: (hosts, leafFor, onSecure) => {
      // One secure context per served host, built once: `leafFor` is the leaf cache the CONNECT acceptors already minted through, so this only wraps each host's leaf in the form node's SNI selection hands out.
      const contexts = new Map<string, tls.SecureContext>(
        hosts.map((host) => {
          const leaf = leafFor(host);
          return [host, tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })];
        }),
      );
      const server = tls.createServer(
        {
          // No default key or cert exists, so the SNI selection is the only source of credentials: an unserved name fails its handshake here, and a client that sent no SNI at all never reaches the selection and fails for want of any certificate, which is exactly the fail-closed shape this surface wants.
          SNICallback: (servername, callback) => {
            const context = contexts.get(servername);
            callback(context === undefined ? new Error(`the transparent surface serves no host named ${servername}`) : null, context);
          },
        },
        (secure) => {
          // node types the servername `string | false | null` because a client may send none, and a handshake that completed here always did (the SNI selection is the only credential source); anything else still fails closed downstream, where no session carries its name.
          onSecure(secure, typeof secure.servername === "string" ? secure.servername : "");
        },
      );
      // A failed handshake (an unserved name, a client that does not trust the CA, a client that speaks no TLS) surfaces here; the only honest response is to drop the connection.
      server.on("clientError", (_error: Error, socket: net.Socket) => {
        socket.destroy();
      });
      return {
        // The same hand-off the single-leaf acceptor uses: emitting the connection event runs the TLS server's own connection listener on a socket this process already owns (the redirect half of the connection) rather than one the server accepted itself.
        accept: (socket) => {
          server.emit("connection", socket);
        },
        close: () => {
          server.close();
        },
      };
    },
    createHttpSession: (handler, onUpgrade) => {
      const server = http.createServer(handler);
      server.on("clientError", (_error, socket) => {
        socket.destroy();
      });
      if (onUpgrade !== undefined) {
        // A server with no 'upgrade' listener has Node destroy the connection itself; with one, the handler owns the socket outright, head bytes included, which is what the byte-level relay needs.
        server.on("upgrade", (request, socket, head) => {
          onUpgrade(request, socket, head);
        });
      }
      return {
        serve: (socket) => {
          server.emit("connection", socket);
        },
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      };
    },
    connectTlsUpstream: async (host, port, clientAlpn) =>
      await new Promise((resolve, reject) => {
        // The upstream half of a tap session speaks TLS to the real host, offering exactly the protocol the client negotiated with the tap's front (and nothing when the client negotiated nothing), so the channel's protocol is the client's choice, never ours. The raw socket is bound into the door's reserved source-port range (the pf exemption an interception deployment loads) before TLS wraps it, because tls.connect's own options carry no localPort.
        const dial = (localPort: number): tls.TLSSocket => {
          const raw = net.connect({ host, port, localPort, lookup: realAddressLookup });
          return tls.connect({ socket: raw, servername: host, ...(clientAlpn === undefined ? {} : { ALPNProtocols: [clientAlpn] }) });
        };
        const settle = (candidate: tls.TLSSocket): void => {
          candidate.once("secureConnect", () => {
            resolve(candidate);
          });
          candidate.once("error", (error: Error) => {
            if ("code" in error && error.code === "EADDRINUSE") {
              // A rotation sibling still holds this port; the next one is free by construction of the range's width.
              settle(dial(upstreamLocalPort()));
              return;
            }
            reject(error);
          });
        };
        settle(dial(upstreamLocalPort()));
      }),
    connectTcp: async (host, port) =>
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.once("connect", () => {
          resolve(socket);
        });
        socket.once("error", reject);
      }),
    forwardHttp: (target, request, response, observer) => {
      const headers = forwardableHeaders(request.headers);
      const options: https.RequestOptions = {
        host: target.host,
        port: target.port,
        lookup: realAddressLookup,
        method: request.method,
        path: request.url,
        headers,
        agent: target.tls ? tlsAgent : plainAgent,
      };
      if (target.tls) {
        options.servername = target.servername ?? target.host;
        if (target.ca !== undefined) {
          options.ca = [...target.ca];
        }
        if (target.rejectUnauthorized !== undefined) {
          options.rejectUnauthorized = target.rejectUnauthorized;
        }
      }
      const onUpstreamResponse = (upstreamResponse: http.IncomingMessage): void => {
        observer?.onResponse(upstreamResponse.statusCode ?? HTTP_BAD_GATEWAY, upstreamResponse.headers);
        response.writeHead(upstreamResponse.statusCode ?? HTTP_BAD_GATEWAY, forwardableHeaders(upstreamResponse.headers));
        // Headers go out before the first body byte: a streaming (SSE) response must reach the client as its chunks arrive, not when it completes.
        response.flushHeaders();
        // Additive listeners, not a tee: the pipe keeps sole control of flow control, and the observer simply sees the same chunk deliveries the client does.
        if (observer !== undefined) {
          upstreamResponse.on("data", (chunk: Buffer) => {
            observer.onResponseChunk(chunk);
          });
        }
        upstreamResponse.pipe(response);
      };
      // Branching rather than selecting the namespace, because a union of the two module objects types `request` as `any` and loses every check on it.
      const upstream = target.tls ? https.request(options, onUpstreamResponse) : http.request(options, onUpstreamResponse);
      upstream.on("error", (error: Error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        const body = `agent-shim headroom: upstream unreachable (${error.message})`;
        response.writeHead(HTTP_BAD_GATEWAY, { "content-type": "text/plain", "content-length": String(body.length) });
        response.end(body);
      });
      if (observer !== undefined) {
        request.on("data", (chunk: Buffer) => {
          observer.onRequestChunk(chunk);
        });
        response.on("close", () => {
          observer.onEnd();
        });
      }
      request.pipe(upstream);
      request.socket.setNoDelay(true);
      upstream.on("socket", (socket) => {
        socket.setNoDelay(true);
      });
    },
  };
}
