# RC interception rig

The Remote Control interception rig captures what Claude Code exchanges with the Anthropic hosts during a real Remote Control session: it is the harness that captured the CCR v2 session behind issues #136 and #137, rebuilt as a script so the procedure no longer lives only in a session transcript. `scripts/rc-interception-rig.sh` brings a disposable Docker container to that state idempotently; re-running `up` converges rather than duplicates.

The rig intercepts at the network layer, which is what makes it complete: nothing inside the container can bypass it, and nothing about the client needs patching.

It has two modes, selected by `RC_RIG_MODE`:

- `proxy` (the default): the container runs the standalone SNI proxy and the iptables redirect points at it. Raw bidirectional capture, the surface the door's tap does not expose.
- `door`: the container runs the real front door from the published agent-shim release and the redirect points at the door's transparent surface, live-verifying the per-host SNI termination released for issue #182 in the field. This is the harness the Remote Control injection work (#136, #137) is proven end to end on.

## Bring-up, proof, teardown

```sh
pnpm install                                        # once, in a checkout of this repo (proxy mode only)
scripts/rc-interception-rig.sh up                   # create/converge the container, proxy mode
RC_RIG_MODE=door scripts/rc-interception-rig.sh up  # or door mode
scripts/rc-interception-rig.sh verify               # prove per-host TLS through the redirect (same mode)
scripts/rc-interception-rig.sh status               # report each piece of the desired state
scripts/rc-interception-rig.sh down                 # stop and remove the container
```

`verify` and `status` report the mode they are given, so set `RC_RIG_MODE` for them too; `verify` refuses outright when it disagrees with the mode recorded in the container. `down` is mode-agnostic: everything either mode sets up lives inside the container, so removing the container is the whole teardown whichever mode converged it, and the same `down` serves both.

The script runs wherever the repo is checked out and talks to whatever Docker `DOCKER_HOST` points at, so `DOCKER_HOST=ssh://<host> scripts/rc-interception-rig.sh up` brings the rig up on a remote Docker host. Proxy mode bundles `scripts/rc-sni-proxy-core.mts` with esbuild on the machine it runs on and copies only the finished bundle into the container (`scripts/rc-sni-proxy.mts` bundles and runs the same core for direct local runs); door mode installs the published release from npm and never touches the checkout, so it runs without dependencies installed. The container the script owns defaults to `rc-intercept-rig`, is labelled, and the script refuses to adopt or remove any container without that label. `rc-capture`, the live reference rig on the Docker host, is rejected by name outright. The container records its mode at `/opt/rc-rig/mode` inside it, and `up` refuses to converge a container brought up in the other mode: both modes listen on the same interception port, so a mixed bring-up would find a listener and mistake it for its own.

## What the rig is

One Docker container from `node:24-slim`, in its own network namespace, containing the pieces both modes share:

- `/etc/hosts` entries pointing the four Anthropic hosts that share one address (`api.anthropic.com`, `platform.claude.com`, `bridge.claudeusercontent.com`, `claude.ai`) at 127.0.0.1, written inside the container.
- An iptables REDIRECT from local 443 to the interception port (47472), exempting the source-port range 47900 to 47919: the door's own upstream dial range (`src/frontdoor/connectEffects.ts`), which the standalone proxy borrows, so the one rule serves both modes.
- Claude Code, installed before the redirect exists.
- Whichever listener the mode selects, listening on 127.0.0.1:47472: the standalone SNI proxy, or the door's transparent surface.

Two environment behaviours the rig depends on, both confirmed on live rigs:

- Claude Code resolves via DNS-over-HTTPS on a macOS or Linux host and ignores `/etc/hosts`. Inside the container the DoH lookup fails (the redirect sends the DoH resolver's own TLS to the terminating listener, which serves only the intercepted hosts) and resolution falls back to the system resolver, where `/etc/hosts` works. Host-level `/etc/hosts` redirection is not viable; container-level is.
- The terminating listener's own upstream dial must leave through the exempt source-port range (47900 to 47919), or the redirect captures it and the listener loops through itself. In door mode that range is the door's own dial range by construction, and the door also resolves upstreams through real DNS (`dns.resolve4`, bypassing the hosts file) with the real hostname as SNI, so its dials reach the real hosts untouched.

A consequence of the redirect worth knowing before you debug: once the rule is in, every TLS host in the container except the intercepted ones is unreachable. Packages, Claude Code and (in door mode) agent-shim are installed before the rule is added for exactly that reason, and a re-run that needs to install something new should `down` and `up` first.

## Proxy mode

The standalone SNI proxy (`scripts/rc-sni-proxy-core.mts`, the script preserved in issue #182): one TLS listener that terminates each redirected host with its own leaf, minted from a CA it generates through the package's own `generateCa` and `mintLeaf`, and pipes each session to that host's real upstream, recording every chunk both ways. `verify` in this mode demands that all four hosts present a leaf matching their own name and verify against the rig's CA at `/tmp/agent-shim-rc-capture/ca/sni-ca.pem`.

## Door mode

`RC_RIG_MODE=door` converges the same container to the door-fronted posture the injection work needs:

- Claude Code and the published agent-shim release (`npm install -g agent-shim`; the release carries the per-host SNI transparent surface from 8.0.2), both installed before the redirect exists like every other package. With both packages under one `npm install -g` prefix, agent-shim and claude sit side by side in `/usr/local/bin`; the launcher's PATH fallback skips only a candidate that is agent-shim itself, so it finds the claude beside it with no further setup.
- An agent-shim home initialised at `/tmp/agent-shim-rig` inside the container, holding an empty identity named `rig` until the manual login.
- The real front door running with its transparent surface on the interception port: started by a detached `agent-shim run @rig --track-usage` whose environment names the surface (`AGENT_SHIM_TRANSPARENT_SURFACE=47472`), turns on the door's capture (`AGENT_SHIM_FRONTDOOR_CAPTURE=1`), and points at the rig's home (`AGENT_SHIM_HOME=/tmp/agent-shim-rig`).
- The same hosts entries and the same redirect, aimed at the door's transparent port; the launch the rig prints then fronts the session itself, with the door's CA trusted through `NODE_EXTRA_CA_CERTS` and the proxy-honouring traffic riding the door's CONNECT surface.

**How the door is started, and why.** The door is normally started by a launch: the launcher's ensure step spawns the detached door supervisor before it spawns the child, and `AGENT_SHIM_TRANSPARENT_SURFACE` is read once, at door start, from the launching process's environment. `--track-usage` is what makes a plain OAuth launch engage the door at all (without a provider, headroom or usage tracking an OAuth launch starts no door; see the configuration model's usage-tracking section). A detached `agent-shim run` is therefore the simplest correct bring-up: it starts the door through the real launch path, and the child it spawns is the session the manual login will take over. Two properties make it durable, both confirmed on the live rig. The supervisor is spawned detached, so the door outlives the launch that started it; and the transparent surface registers a session against the door's own pid, which the idle pruner never reaps while the door serves, so a door with the surface on never idles out. The child itself exits at once under `docker exec -d` (no terminal, so Claude Code falls into `--print` mode and errors on the empty stdin, recorded in `logs/rig-launch.log`); that is expected and costs nothing, because the door is already serving by then, and the printed manual step is the interactive launch that performs the real login and joins the live door.

**What `verify` proves here.** The same per-host openssl proof as proxy mode, through the redirect, against the door's own CA at `/tmp/agent-shim-rig/frontdoor/ca/ca.pem`, with one honest difference: the door's transparent surface terminates exactly its intercept set (`CONNECT_INTERCEPT_HOSTS` in `src/frontdoor/connect.ts`), which is `api.anthropic.com` and `platform.claude.com`, the two hosts the Remote Control channel uses. Those two must present a leaf matching their own name and verify against the door's CA. The other two redirected names, `claude.ai` and `bridge.claudeusercontent.com`, must be refused with no certificate at all: that is the door's designed fail-closed answer for a name outside its set, and `verify` asserts the refusal as its own pass condition rather than skipping those hosts. A pass proves the door's termination and its refusal discipline, and nothing more: a full RC session additionally needs the manual login.

A practical consequence of the intercept set: traffic to `claude.ai` and `bridge.claudeusercontent.com` does not work in door mode, because the redirect delivers it to the door and the door refuses the name. When a session needs those hosts as well as the intercepted two, run the standalone proxy mode, which terminates and pipes all four.

The door's capture is on from the moment the rig starts it, and writes `/tmp/agent-shim-rig/logs/frontdoor-capture.jsonl` inside the container (the door's own log is beside it at `logs/frontdoor.log`; the detached launch's output at `logs/rig-launch.log`). A decompressed frame can embed live credential material, so the file is disposable: read it, then delete it, and never commit it. Websocket frames decode offline with `scripts/decode-stream-capture.mts`. The capture is decided at door start, so a launch that joins a running door cannot switch it; a `down` and `up` restarts the door and with it the capture.

## The manual login step

RC activation needs an interactive full-scope browser login, and the script deliberately does not automate it: setup tokens are limited to inference scope server-side, and credential-file tokens fail the client-side scope check. `up` prints the exact way in for each mode.

Proxy mode, pointing Claude Code's trust at the rig's CA by hand:

```sh
docker exec -it rc-intercept-rig sh
export NODE_EXTRA_CA_CERTS=/tmp/agent-shim-rc-capture/ca/sni-ca.pem
claude
```

Door mode, launching through agent-shim so the door fronts the session (the launcher sets `NODE_EXTRA_CA_CERTS` to the door's CA and `HTTPS_PROXY` to the door's CONNECT surface itself; no manual export is needed):

```sh
docker exec -it rc-intercept-rig sh
export AGENT_SHIM_HOME=/tmp/agent-shim-rig
agent-shim run @rig --track-usage
```

Complete the browser login the session opens (on any machine with a browser). In proxy mode captured frames accumulate in `/tmp/agent-shim-rc-capture/logs/frontdoor-capture.jsonl` inside the container; in door mode the door's capture (already on) records to `/tmp/agent-shim-rig/logs/frontdoor-capture.jsonl`. Websocket frames in either file decode offline with `scripts/decode-stream-capture.mts`. Both captures can contain credential material: read them, then delete them, and never commit them.

## The self-hosted proof (no login at all)

The self-hosted Remote Control mode (issue #207) removes the manual login from the proof entirely: the door serves the CCR surface itself, so a session activates Remote Control against the door with no Anthropic credential anywhere. On a door-mode rig:

```sh
# inside the container, against the rig's agent-shim home
export AGENT_SHIM_HOME=/tmp/agent-shim-rig
agent-shim frontdoor rc selfhost mint rig        # mint the local credential (never prints a token)
```

then start the door with the mode on (`AGENT_SHIM_FRONTDOOR_RC_SELF_HOST=1` beside the transparent-surface and capture variables on the detached launch that starts it, or restart the door so they are read at start), relaunch the session (`agent-shim run @rig --track-usage --remote-control`), and switch Remote Control on in the session. Inference still routes exactly as it otherwise would (a provider of your own, or the real API when a real login exists; a minted credential alone does not make the real API answer `/v1/messages`), and every Remote Control exchange is served by the door: `frontdoor rc list` tracks the session, `frontdoor rc send` delivers a prompt, `frontdoor rc pending` and `rc answer` carry the approvals, and `frontdoor rc watch` streams both halves.

A provider and Remote Control do coexist in one session now: a provider launch keeps the OAuth launch's shape (no base URL for the gate to refuse), the door routes its inference by the provider header and attaches the provider's own credential at the route, so the approval chain and the model's turns run in one session against one provider. `scripts/rc-mock-provider.mts` is a provider of your own for exactly this proof: a loopback Anthropic-messages server that answers the first turn of a conversation with a Bash tool_use writing `/tmp/approval-proof-ok` (a file write, so the CLI raises a real permission request; a plain `echo` is auto-approved as read-only and never reaches the approval path) and the tool's follow-up with final text naming what it printed, refusing any request that does not carry the credential the door attached. Run it inside the container (`RC_MOCK_TOKEN=<the provider's literal credential> node scripts/rc-mock-provider.mts --port 47474`, after lifting the iptables redirect if anything needs installing), point a provider file at `http://127.0.0.1:47474` with a `literal` credential, and the whole proof runs with no model and no secret. Two Remote Control details the proof also pins: the door lists a pending approval for fourteen seconds only (the protocol's permission round-trip bound), so `rc answer` must follow `rc/pending` promptly; and a fresh Remote Control session starts in auto mode, so `frontdoor rc set-permission-mode --session <id> --mode default` before the prompt is what makes the tool call ask rather than act.

The door's capture and the door's log are the observation surfaces, and the same disposal rule applies. The mode's protocol surface is pinned to the CLI version the rig installs and must be re-verified on upgrades (the standing caveat of issue #207: the transport changed shape once already within the 2.1.x line).

The browser surface of this proof is the door's self-hosted web client (see [docs/rc-web-client.md](rc-web-client.md)): served by the same provider listener under `__agent-shim/client`, behind the same control token, listing the rig's Remote Control sessions and carrying prompts and approvals from a real browser with no Anthropic credential anywhere.
