/**
 * The RC interception rig's standalone SNI proxy: one `tls.Server` that terminates every redirected host with its own leaf, minted from a CA this script generates, and pipes each session to that host's real upstream. It preserves the proxy proven live on the reference rig, whose source is quoted verbatim in ExaDev/agent-shim#182, with three adaptations:
 *
 * - the CA is persisted (certificate and key) and reused across restarts, so a re-run of the rig does not invalidate the container's `NODE_EXTRA_CA_CERTS` or an already completed login;
 * - the upstream address is resolved at startup through `dns.resolve4` instead of the address the original rig had hardcoded from its `/etc/hosts`: `resolve4` asks the nameserver directly and never consults `/etc/hosts`, whose entries now pin this very host to 127.0.0.1. The door's own upstream dials use the same fact (`realAddressLookup` in `src/frontdoor/connectEffects.ts`);
 * - the code carries types for this repo's strict TypeScript.
 *
 * The rig's bring-up script (`scripts/rc-interception-rig.sh`) bundles this file with esbuild into one self-contained `.mjs` and runs that inside the container; `scripts/rc-sni-proxy.mts` does the same for direct runs from a checkout. It listens on 127.0.0.1 only.
 *
 * The capture file this proxy writes can contain credential material: read it, then delete it; never commit it.
 */
import * as dns from "node:dns/promises";
import * as fs from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

import { generateCa, mintLeaf, type CaMaterial } from "../src/frontdoor/connect";

const HOME = "/tmp/agent-shim-rc-capture";
const CA_CERT_PATH = `${HOME}/ca/sni-ca.pem`;
const CA_KEY_PATH = `${HOME}/ca/sni-ca.key.pem`;

/** The port the rig's iptables REDIRECT sends every local 443 connection to; `scripts/rc-interception-rig.sh` names the same port where it writes that rule. */
const PROXY_PORT = 47472;

/** The port real HTTPS is served on upstream. */
const UPSTREAM_PORT = 443;

/**
 * The source-port range this proxy's own upstream dials bind, matching the redirect's exemption in `scripts/rc-interception-rig.sh`: without it, the proxy's dial to the real address would be redirected straight back into itself, an endless loop. The range is the door's own upstream dial range (`src/frontdoor/connectEffects.ts`), so the same exemption keeps holding when the rig's redirect is retargeted at the door's transparent port.
 */
const UPSTREAM_SOURCE_PORT_START = 47900;
const UPSTREAM_SOURCE_PORT_END = 47919;

/** The four Anthropic hosts that share one address, so one redirect carries them all and each needs its own leaf to pass hostname verification. */
const HOSTS = ["api.anthropic.com", "platform.claude.com", "bridge.claudeusercontent.com", "claude.ai"] as const;

/** Bytes of each captured chunk kept in the JSONL record (the preserved rig script's cap, kept so records stay line-shaped under an unbounded stream); the console excerpt keeps one frame's echo short the same way. */
const CAPTURE_DATA_CAP = 500;
const CONSOLE_EXCERPT_CAP = 150;

/** Loads the persisted CA, generating and persisting one when not both halves exist: a cert without its key can sign nothing, so it counts as absent and is replaced (the same rule `ensureCa` applies to the door's own CA). Persisting the key as well as the cert is what keeps a rig re-run from invalidating the container's `NODE_EXTRA_CA_CERTS`. */
function loadOrGenerateCa(): CaMaterial {
  if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
    return { certPem: fs.readFileSync(CA_CERT_PATH, "utf8"), keyPem: fs.readFileSync(CA_KEY_PATH, "utf8") };
  }
  const ca = generateCa(new Date());
  fs.writeFileSync(CA_CERT_PATH, ca.certPem);
  fs.writeFileSync(CA_KEY_PATH, ca.keyPem, { mode: 0o600 });
  return ca;
}

/**
 * Resolves the address the four hosts share, once at startup. `dns.resolve4` interrogates the nameserver from `/etc/resolv.conf` directly: unlike `dns.lookup` (getaddrinfo) it never consults `/etc/hosts`, whose entries now pin these very hosts to 127.0.0.1, and it rides UDP 53, which the rig's port-443 redirect never touches. Every host in `HOSTS` shares this address, which is the fact that lets one redirect and one dial target carry them all.
 */
async function resolveUpstreamAddress(): Promise<string> {
  const addresses = await dns.resolve4("api.anthropic.com");
  const address = addresses[0];
  if (address === undefined) {
    throw new Error("dns.resolve4 returned no address for api.anthropic.com");
  }
  return address;
}

fs.mkdirSync(`${HOME}/ca`, { recursive: true });
fs.mkdirSync(`${HOME}/logs`, { recursive: true });
const ca = loadOrGenerateCa();
const upstreamAddress = await resolveUpstreamAddress();
console.log(`upstream address for ${HOSTS.join(", ")}: ${upstreamAddress}; CA at ${CA_CERT_PATH}`);

const contexts = new Map<string, tls.SecureContext>();
const apiLeaf = mintLeaf(ca, ["api.anthropic.com"], new Date());
contexts.set("api.anthropic.com", tls.createSecureContext({ key: apiLeaf.keyPem, cert: apiLeaf.certPem }));
for (const host of HOSTS) {
  if (host === "api.anthropic.com") {
    continue;
  }
  const leaf = mintLeaf(ca, [host], new Date());
  contexts.set(host, tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem }));
}

const captureFile = `${HOME}/logs/frontdoor-capture.jsonl`;
let frameId = 0;
let upstreamPort = UPSTREAM_SOURCE_PORT_START;

/** Appends one captured chunk to the JSONL capture (text when it survives a UTF-8 round trip, base64 otherwise, each capped per frame so an unbounded stream cannot grow one line without limit) and echoes text frames to the proxy log. */
const log = (dir: "client_to_server" | "server_to_client", host: string, data: Buffer): void => {
  frameId++;
  const isText = !data.includes(0);
  fs.appendFileSync(captureFile, JSON.stringify({
    ts: new Date().toISOString(),
    id: frameId,
    dir,
    host,
    data: isText ? data.toString("utf8").slice(0, CAPTURE_DATA_CAP) : data.toString("base64").slice(0, CAPTURE_DATA_CAP),
  }) + "\n");
  if (isText) console.log(`[${dir} ${host}] ${data.toString("utf8").slice(0, CONSOLE_EXCERPT_CAP)}`);
};

const server = tls.createServer({
  SNICallback: (servername, callback) => {
    const context = contexts.get(servername);
    callback(context === undefined ? new Error(`unknown servername: ${servername}`) : null, context);
  },
  key: apiLeaf.keyPem,
  cert: apiLeaf.certPem,
}, (clientSocket) => {
  // servername is false (no SNI) or null (not negotiated) as well as a name; the preserved script's falsy fallback maps every such case to the API host, whose leaf is also the listener's default certificate.
  const sni = clientSocket.servername;
  const host = typeof sni === "string" && sni !== "" ? sni : "api.anthropic.com";
  console.log(`=== ${host} connected ===`);

  // The client's first flight must not be consumed before the upstream pipe
  // exists: pause immediately and resume only once the upstream TLS session is
  // established, or the session stalls with its ClientHello already read.
  clientSocket.pause();

  const port = upstreamPort;
  upstreamPort = upstreamPort >= UPSTREAM_SOURCE_PORT_END ? UPSTREAM_SOURCE_PORT_START : upstreamPort + 1;
  const rawSocket = net.connect({ host: upstreamAddress, port: UPSTREAM_PORT, localPort: port });
  const upstream = tls.connect({ socket: rawSocket, servername: host }, () => {
    console.log(`=== ${host} upstream ready ===`);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    clientSocket.resume();
  });

  clientSocket.on("data", (chunk: Buffer) => { log("client_to_server", host, chunk); });
  upstream.on("data", (chunk: Buffer) => { log("server_to_client", host, chunk); });
  const cleanup = (): void => { clientSocket.destroy(); upstream.destroy(); rawSocket.destroy(); };
  clientSocket.on("error", (error: Error) => { console.log(`${host} client err: ${error.message}`); cleanup(); });
  upstream.on("error", (error: Error) => { console.log(`${host} upstream err: ${error.message}`); cleanup(); });
  rawSocket.on("error", (error: Error) => { console.log(`${host} raw err: ${error.message}`); cleanup(); });
  clientSocket.on("close", () => { upstream.destroy(); rawSocket.destroy(); });
  upstream.on("close", () => { clientSocket.destroy(); });
  rawSocket.on("close", () => { if (!upstream.destroyed) upstream.destroy(); });
});

server.listen(PROXY_PORT, "127.0.0.1", () => { console.log(`SNI proxy on 127.0.0.1:${String(PROXY_PORT)} (with pause/resume); capture at ${captureFile}`); });
