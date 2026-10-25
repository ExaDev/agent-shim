/**
 * Reads the RC rig's SNI proxy capture file and prints the HTTP exchanges it recorded, with chunked framing removed and compressed bodies decoded: the offline way to read the request and response bodies of a protocol the rig observed.
 *
 * Usage: node scripts/decode-http-capture.mts PATH-TO-CAPTURE-FILE [--match TEXT] [--shape] `--match` keeps the exchanges whose request line (method and target) contains TEXT; `--shape` prints each JSON body as its keys and value types instead of its content. Credential headers and credential-named JSON fields print as placeholders, but a body is the live protocol's payload and can hold other secrets: read the output, then delete the capture; never paste either anywhere.
 */
import * as fs from "node:fs";

import { decodeExchanges, matchesRequest, parseCapture, renderExchange } from "./decode-http-capture-core";

const USAGE = "usage: node scripts/decode-http-capture.mts PATH-TO-CAPTURE-FILE [--match TEXT] [--shape]";

const args = process.argv.slice(2);
const file = args[0];
if (file === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const matchFlag = args.indexOf("--match");
const needle = matchFlag < 0 ? undefined : args[matchFlag + 1];
if (matchFlag >= 0 && needle === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const shape = args.includes("--shape");

try {
  for (const exchange of decodeExchanges(parseCapture(fs.readFileSync(file, "utf8")))) {
    if (needle === undefined || matchesRequest(exchange, needle)) {
      console.log(renderExchange(exchange, { shape }));
    }
  }
} catch (error) {
  console.error(`decode-http-capture: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
