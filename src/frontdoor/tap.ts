import type * as net from "node:net";
import type { Duplex } from "node:stream";

import type { StreamTap } from "./capture";

/**
 * Pumps one already-TLS-terminated stream byte for byte to its real host over a fresh TLS connection, teeing every chunk in both directions into `tap` when one is given. This is the instrumentation for a host whose protocol the surface does not parse: the claude.ai control plane carries Remote Control on a channel that mixes shapes (observed under capture: an HTTP/1.1-shaped token request first, then binary HTTP/2 frames around it), so parsing it as either protocol would destroy or distort it. Pass everything through unchanged and record, never interpret: the frames are decoded offline, and a protocol the door does not understand keeps working exactly as the blind tunnel served it.
 *
 * Lifecycle mirrors `blindTunnel`: whoever goes away first takes the other side with it, so neither half of a tap session ever outlives its peer. The tap's listeners ride beside the pipes, additive like every other observer in this surface, so a recording failure fails loudly rather than silently stopping a diagnostic.
 */
export function pumpTapSession(secure: Duplex, openUpstream: (clientAlpn: string | undefined) => Promise<net.Socket>, tap: StreamTap | undefined, prefix: Readonly<Buffer> = Buffer.alloc(0)): void {
  let upstream: net.Socket | undefined;
  let ended = false;
  const end = (): void => {
    if (!ended) {
      ended = true;
      tap?.onEnd();
    }
  };
  const drop = (): void => {
    end();
    secure.destroy();
    upstream?.destroy();
  };
  secure.once("close", () => {
    end();
    upstream?.destroy();
  });
  secure.once("error", drop);
  // The protocol the client negotiated with this surface's own TLS, forwarded as the only protocol offered upstream. Offering h2 upstream regardless (the first version of this tap did) answers an HTTP/1.1-speaking client with an HTTP/2 SETTINGS frame, which is binary garbage to it: the tap broke the very channel it existed to observe. A client that negotiated nothing is piped to an upstream that offers nothing, exactly as the blind tunnel served it.
  const clientAlpn = "alpnProtocol" in secure && typeof secure.alpnProtocol === "string" ? secure.alpnProtocol : undefined;
  void (async () => {
    try {
      upstream = await openUpstream(clientAlpn);
    } catch {
      // Nothing to pump to: the only honest response is to drop the client's session, exactly as a blind tunnel with no target is dropped.
      drop();
      return;
    }
    if (secure.destroyed) {
      // The client went away while the upstream was being dialled; the close handler above has not yet seen a socket to clean up, so do it here.
      end();
      upstream.destroy();
      return;
    }
    if (prefix.length > 0) {
      // Bytes that must reach the upstream before anything piped from the client: a relayed upgrade's reconstructed request head, whose original the client's own HTTP parser consumed and will never re-send.
      upstream.write(prefix);
    }
    if (tap !== undefined) {
      secure.on("data", (chunk: Buffer) => {
        tap.onChunk("client-to-server", chunk);
      });
      upstream.on("data", (chunk: Buffer) => {
        tap.onChunk("server-to-client", chunk);
      });
    }
    secure.pipe(upstream);
    upstream.pipe(secure);
    upstream.once("close", drop);
    upstream.once("error", drop);
  })();
}
