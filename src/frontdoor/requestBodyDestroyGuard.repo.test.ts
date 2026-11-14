import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The files that read a Messages request body under a cap. None may destroy a stream that is, or carries, the connection's own request: destroying it resets the socket a client may still be uploading on, so the 413 never reaches it. */
const FILES = ["httpRequestEdits.ts", "cappedBody.ts", "requestScan.ts", "providerRoute.ts"] as const;

/**
 * A `.destroy(` on anything that names a request body: `working.body`, `served.body`, `request.body`, `request`, `req`, `incoming`, a bare `body`, or a socket (`.socket.destroy(`), each with or without optional chaining. The scan's own replay stream (`replay.destroy(cause)`) is its own to destroy with the body's failure and is not matched. This is a name pattern, not an analysis: an alias of a body (`const b = working.body; b.destroy()`) is caught only by the real-socket tests, which observe the streams themselves.
 */
const REQUEST_BODY_DESTROY = /\b(?:(?:working|served|request)\??\.body|request|req|incoming|body)\??\.destroy\(|\.socket\??\.destroy\(/;

describe("no read of a Messages request body destroys the request stream", () => {
  it.each(FILES)("%s", (file) => {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    expect(text).not.toMatch(REQUEST_BODY_DESTROY);
  });

  it("matches the shapes it exists to catch", () => {
    for (const shape of ["working.body.destroy()", "served.body.destroy(error)", "request.destroy()", "req.destroy()", "incoming.destroy()", "body.destroy()", "body?.destroy()", "working?.body?.destroy()", "request.socket.destroy()", "response.socket?.destroy()"]) {
      expect(shape).toMatch(REQUEST_BODY_DESTROY);
    }
    expect("replay.destroy(cause)").not.toMatch(REQUEST_BODY_DESTROY);
  });
});
