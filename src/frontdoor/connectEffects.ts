import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";

import { HTTP_BAD_GATEWAY, forwardableHeaders, type ConnectEffects, type ConnectListenerHandle } from "./connect";

/** The real `ConnectEffects` over node's own net, tls, and http. `connectTcp` opens real connections to the CONNECTed host, so tests that want a blind tunnel redirect it. */
export function realConnectEffects(): ConnectEffects {
  // Keep-alive on both agents so a client reusing its TLS session gets its forwarded requests served over reused upstream connections too, the way a direct connection would.
  const plainAgent = new http.Agent({ keepAlive: true });
  const tlsAgent = new https.Agent({ keepAlive: true });

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
      const server = tls.createServer(
        { key: leaf.keyPem, cert: leaf.certPem, ...(alpnProtocols === undefined ? {} : { ALPNProtocols: [...alpnProtocols] }) },
        (secure) => {
          onSecure(secure);
        },
      );
      // A failed handshake (a client that does not trust the CA, or speaks no TLS) surfaces here; the only honest response is to drop the connection.
      server.on("clientError", (_error: Error, socket: net.Socket) => {
        socket.destroy();
      });
      return {
        // tls.Server is a net.Server whose connection listener wraps the raw socket in the TLS handshake, and emitting the event by hand is what runs that listener on a socket this process already owns (the CONNECT half of the connection) rather than one the server accepted itself.
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
        // A server with no 'upgrade' listener has Node destroy the connection itself; this handler sees the request through the capture and then destroys it, preserving that outcome exactly whether or not anything is being recorded.
        server.on("upgrade", (request, socket) => {
          onUpgrade(request);
          socket.destroy();
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
        // The upstream half of a tap session speaks TLS to the real host, offering exactly the protocol the client negotiated with the tap's front (and nothing when the client negotiated nothing), so the channel's protocol is the client's choice, never ours.
        const socket = tls.connect({ host, port, servername: host, ...(clientAlpn === undefined ? {} : { ALPNProtocols: [clientAlpn] }) });
        socket.once("secureConnect", () => {
          resolve(socket);
        });
        socket.once("error", reject);
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
