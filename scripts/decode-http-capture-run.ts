/**
 * Reads the RC rig's SNI proxy capture file and prints the HTTP exchanges it recorded, with chunked framing removed and compressed bodies decoded, and the WebSocket messages of an upgraded connection after its handshake: the offline way to read the request and response bodies of a protocol the rig observed.
 *
 * Usage: node scripts/decode-http-capture.mts PATH-TO-CAPTURE-FILE [--match TEXT] [--shape] `--match` keeps the exchanges whose request line (method and target) contains TEXT; `--shape` prints each JSON body as its keys and value types instead of its content; `--contract` instead folds every exchange into one entry per endpoint (identifiers in the path replaced) with the bodies of all its samples merged into one shape, optional keys marked `?`, and the messages of a WebSocket connection grouped by kind. Credential headers and credential-named JSON fields print as placeholders, but a body is the live protocol's payload and can hold other secrets: read the output, then delete the capture; never paste either anywhere.
 */
import * as fs from "node:fs";

import { renderContracts, summariseContracts } from "./decode-contract-core";
import { decodeExchanges, matchesRequest, parseCapture, renderExchange } from "./decode-http-capture-core";

const USAGE = "usage: node scripts/decode-http-capture.mts PATH-TO-CAPTURE-FILE [--match TEXT] [--shape | --contract]";

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
const contract = args.includes("--contract");
if (shape && contract) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const exchanges = decodeExchanges(parseCapture(fs.readFileSync(file, "utf8"))).filter((exchange) => needle === undefined || matchesRequest(exchange, needle));
  if (contract) {
    console.log(renderContracts(summariseContracts(exchanges)));
  } else {
    for (const exchange of exchanges) {
      console.log(renderExchange(exchange, { shape }));
    }
  }
} catch (error) {
  console.error(`decode-http-capture: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
