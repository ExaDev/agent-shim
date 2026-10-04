# RC interception rig

The Remote Control interception rig captures what Claude Code exchanges with the Anthropic hosts during a real Remote Control session: it is the harness that captured the CCR v2 session behind issues #136 and #137, rebuilt as a script so the procedure no longer lives only in a session transcript. `scripts/rc-interception-rig.sh` brings a disposable Docker container to that state idempotently; re-running `up` converges rather than duplicates.

The rig intercepts at the network layer, which is what makes it complete: nothing inside the container can bypass it, and nothing about the client needs patching.

## Bring-up, proof, teardown

```sh
pnpm install                       # once, in a checkout of this repo
scripts/rc-interception-rig.sh up     # create/converge the container
scripts/rc-interception-rig.sh verify # prove per-host TLS through the redirect
scripts/rc-interception-rig.sh status # report each piece of the desired state
scripts/rc-interception-rig.sh down   # stop and remove the container
```

The script runs wherever the repo is checked out and talks to whatever Docker `DOCKER_HOST` points at, so `DOCKER_HOST=ssh://<host> scripts/rc-interception-rig.sh up` brings the rig up on a remote Docker host. It bundles `scripts/rc-sni-proxy-core.mts` with esbuild on the machine it runs on and copies only the finished bundle into the container (`scripts/rc-sni-proxy.mts` bundles and runs the same core for direct local runs). The container it owns defaults to `rc-intercept-rig`, is labelled, and the script refuses to adopt or remove any container without that label. `rc-capture`, the live reference rig on the Docker host, is rejected by name outright.

## What the rig is

One Docker container from `node:24-slim`, in its own network namespace, containing:

- `/etc/hosts` entries pointing the four Anthropic hosts that share one address (`api.anthropic.com`, `platform.claude.com`, `bridge.claudeusercontent.com`, `claude.ai`) at 127.0.0.1, written inside the container.
- An iptables REDIRECT from local 443 to the SNI proxy port, exempting the source-port range the proxy's own upstream dials leave through.
- The standalone SNI proxy (`scripts/rc-sni-proxy-core.mts`, the script preserved in issue #182): one TLS listener that terminates each redirected host with its own leaf, minted from a CA it generates through the package's own `generateCa` and `mintLeaf`, and pipes each session to that host's real upstream, recording every chunk both ways.
- Claude Code, launched with `NODE_EXTRA_CA_CERTS` pointing at the rig's CA.

Two environment behaviours the rig depends on, both confirmed on live rigs:

- Claude Code resolves via DNS-over-HTTPS on a macOS or Linux host and ignores `/etc/hosts`. Inside the container the DoH lookup fails (the redirect sends the DoH resolver's own TLS to the proxy, which serves only the four intercepted hosts) and resolution falls back to the system resolver, where `/etc/hosts` works. Host-level `/etc/hosts` redirection is not viable; container-level is.
- The proxy's own upstream dial must leave through the exempt source-port range (47900 to 47919), or the redirect captures it and the proxy loops through itself. That range is the front door's own upstream dial range (`src/frontdoor/connectEffects.ts`), so the same exemption keeps holding when the redirect is retargeted at the door.

A consequence of the redirect worth knowing before you debug: once the rule is in, every TLS host in the container except the four intercepted ones is unreachable. Packages and Claude Code are installed before the rule is added for exactly that reason, and a re-run that needs to install something new should `down` and `up` first.

## The manual login step

RC activation needs an interactive full-scope browser login, and the script deliberately does not automate it: setup tokens are limited to inference scope server-side, and credential-file tokens fail the client-side scope check. `up` prints the exact way in:

```sh
docker exec -it rc-intercept-rig sh
export NODE_EXTRA_CA_CERTS=/tmp/agent-shim-rc-capture/ca/sni-ca.pem
claude
```

Complete the browser login it opens (on any machine with a browser), and captured frames accumulate in `/tmp/agent-shim-rc-capture/logs/frontdoor-capture.jsonl` inside the container. Websocket frames in that file decode offline with `scripts/decode-stream-capture.mts`. The capture can contain credential material: read it, then delete it, and never commit it.

## The transparent-port follow-up

The rig's interception surface is deliberately the standalone proxy, because raw bidirectional capture is what it exists for. The fix for issue #182 has landed: the door's transparent surface terminates each intercept host with its own leaf keyed on SNI, so the redirect can be retargeted at the door's own transparent port to exercise injection and worker impersonation end to end while the standalone proxy stays the fallback for capture the door's tap does not expose. The rig script's header records this as the next step; running the door inside the container is not wired up ahead of that work.
