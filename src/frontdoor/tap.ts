import type * as net from "node:net";

import type { StreamTap } from "./capture";

/**
 * Pumps one already-TLS-terminated stream byte for byte to its real host over a fresh TLS connection, teeing every chunk in both directions into `tap` when one is given. This is the instrumentation for a host whose protocol the surface does not parse: the claude.ai control plane carries Remote Control on a channel where no HTTP/1.1 byte ever appears (observed under capture: the CONNECT session opens, the client's OAuth token refresh on the API host succeeds, and then nothing parseable crosses), so the only honest instrument is the byte level. Pass everything through unchanged and record, never interpret: the frames are decoded offline, and a protocol the door does not understand keeps working exactly as the blind tunnel served it.
 *
 * Lifecycle mirrors `blindTunnel`: whoever goes away first takes the other side with it, so neither half of a tap session ever outlives its peer. The tap's listeners ride beside the pipes, additive like every other observer in this surface, so a recording failure fails loudly rather than silently stopping a diagnostic.
 */
export function pumpTapSession(secure: net.Socket, openUpstream: () => Promise<net.Socket>, tap: StreamTap | undefined): void {
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
  void (async () => {
    try {
      upstream = await openUpstream();
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
