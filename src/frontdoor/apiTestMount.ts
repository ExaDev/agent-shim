import * as http from "node:http";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AnyRouter, RouterClient } from "@orpc/server";

import { doorApiNodeHandlerOf, RC_ORPC_PATH_PREFIX } from "./rcApi";

/** Mounts one router of the door's typed API on a plain loopback listener through the same node handler the provider listener mounts (prefix, token middleware and body cap included) and returns a typed client for it presenting `token`. `expectedToken` is the value the mount demands. */
export async function mountRouterClient<R extends AnyRouter>(router: R, expectedToken: string, token: string): Promise<{ readonly client: RouterClient<R>; readonly url: string; readonly close: () => Promise<void> }> {
  const surface = doorApiNodeHandlerOf(router, expectedToken);
  // The listener owns the rejection path here (the door's own listener logs it), so a rejection surfaces on the console rather than being swallowed or failing the process.
  const server = http.createServer((request, response) => {
    void surface.handle(request, response).catch((error: unknown) => {
      console.error(error);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    client: createORPCClient(new RPCLink({ origin, url: RC_ORPC_PATH_PREFIX, headers: { authorization: `Bearer ${token}` } })),
    url: `${origin}${RC_ORPC_PATH_PREFIX}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    },
  };
}
