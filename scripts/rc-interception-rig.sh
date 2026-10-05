#!/bin/sh
# Remote Control interception rig (ExaDev/agent-shim#184): an idempotent, reproducible bring-up of the capture container whose hand-built ancestor captured the real CCR v2 session behind ExaDev/agent-shim#136 and #137. Re-running "up" converges the container to the desired state (check-then-act on the container, the hosts entries and the iptables rule) rather than duplicating or failing.
#
# Two modes, selected by RC_RIG_MODE (proxy or door, default proxy). Both write the same /etc/hosts entries and the same exempt-port iptables redirect; only the listener the redirect points at differs.
#
#   proxy (default): the standalone SNI proxy (scripts/rc-sni-proxy-core.mts, the script preserved in issue #182) terminates each of the four intercepted hosts with its own leaf and records every chunk both ways. Raw bidirectional capture the door's tap does not expose.
#
#   door: the real front door from the published agent-shim release, started in the container with its transparent surface on the interception port, and the redirect aimed at that surface. This live-verifies the per-host SNI transparent surface (#182, released in 8.0.2) in the field and is the harness the Remote Control injection work (#136, #137) is proven end to end on: the door terminates, attributes and admits each host's traffic where the standalone proxy only records it.
#
# Subcommands:
#
#   up: create/start the container if needed, then converge it in the selected mode. Proxy mode installs the packages, bundles and starts the SNI proxy, writes the hosts entries, installs Claude Code, adds the redirect, prints the manual login step. Door mode installs the packages, Claude Code (linked into the launcher's versions directory so the launcher discovers it) and the published agent-shim release (all before the redirect exists, like every install), initialises an agent-shim home and identity in the container, starts the door through a detached agent-shim run whose environment names the transparent surface, then writes the same hosts entries and the same redirect aimed at the door's transparent port, and prints the manual login step for that path.
#
#   down: stop and remove the container this script created. Mode-agnostic: everything either mode sets up lives inside that container, so one teardown serves both and no mode needs stating.
#
#   status: report each piece of the desired state without changing anything. Run it in the mode the container was brought up in; it also prints the mode recorded in the container.
#
#   verify: prove per-host TLS inside the container, through the redirect, against the CA of whichever listener terminates it. Proxy mode: for every intercepted host, openssl s_client against 127.0.0.1:443 must present a leaf whose SAN matches that host and verify against the rig's CA. Door mode: the same proof against the door's CA for the door's intercept hosts (api.anthropic.com, platform.claude.com), and the opposite proof for the other two redirected hosts: the door serves only its intercept set, so claude.ai and bridge.claudeusercontent.com must be refused with no certificate at all. A verify pass proves the door's termination; a full RC session additionally needs the manual login.
#
# Run from a checkout of this repo. Proxy mode bundles from the checkout and needs dependencies installed (pnpm install); door mode never touches the checkout, so it runs without them. Every docker call honours DOCKER_HOST, so DOCKER_HOST=ssh://<host> brings the rig up on a remote Docker host; the esbuild bundling always happens on the machine running this script and only the finished bundle is copied in.
#
# The container this script owns defaults to rc-intercept-rig and carries the label below; it refuses to adopt a container without that label. rc-capture is the live reference rig on the Docker host and is never touched: that name is rejected outright. The container records its mode at /opt/rc-rig/mode, and "up" refuses to converge a container brought up in the other mode: both modes listen on the same interception port, so a mixed bring-up would find a listener and mistake it for its own.
#
# The one manual step, RC activation, is printed at the end of every "up" and is deliberately not automated: it needs an interactive full-scope browser login, because setup tokens are limited to inference scope server-side and credential-file tokens fail the client-side scope check.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

MODE=${RC_RIG_MODE:-proxy}
case "$MODE" in
  proxy | door) ;;
  *) printf 'rc-interception-rig: RC_RIG_MODE must be proxy or door, not "%s"\n' "$MODE" >&2; exit 2 ;;
esac

# Deliberately NOT rc-capture: that is the live reference rig on the Docker host and this script must never touch it.
CONTAINER_NAME=${RC_RIG_CONTAINER:-rc-intercept-rig}
IMAGE=${RC_RIG_IMAGE:-node:24-slim}
RIG_LABEL=org.exadev.agent-shim.rc-interception-rig
PROXY_BUNDLE="$REPO_ROOT/dist/rc-sni-proxy.mjs"

# The interception port: the standalone SNI proxy's listen port in proxy mode (scripts/rc-sni-proxy-core.mts names the same port) and the door's transparent-surface port in door mode (AGENT_SHIM_TRANSPARENT_SURFACE names it on the launch that starts the door). One port keeps the redirect rule single-source: whichever mode converged the container, the rule is the same one.
INTERCEPT_PORT=47472

# Source ports the terminating listener's own upstream dials leave through, excluded from the redirect so the dial cannot be captured and looped back through the same listener. This is the door's own upstream dial range (src/frontdoor/connectEffects.ts); the standalone proxy borrows it, so one rule serves both modes.
EXEMPT_SOURCE_PORTS=47900:47919

# The four Anthropic hosts that share one address; scripts/rc-sni-proxy-core.mts mints one leaf per host from the same list. The door terminates only its own intercept set (DOOR_INTERCEPT_HOSTS below) and refuses the rest.
INTERCEPT_HOSTS="api.anthropic.com platform.claude.com bridge.claudeusercontent.com claude.ai"

# Door mode: the door's intercept set (CONNECT_INTERCEPT_HOSTS in src/frontdoor/connect.ts), the agent-shim home initialised in the container, the identity the rig creates in it, and the detached launch's combined output. The door's own CA and logs live under the home: frontdoor/ca/ca.pem and logs/frontdoor.log.
DOOR_INTERCEPT_HOSTS="api.anthropic.com platform.claude.com"
DOOR_HOME=/tmp/agent-shim-rig
DOOR_CA="$DOOR_HOME/frontdoor/ca/ca.pem"
DOOR_IDENTITY=rig
DOOR_LAUNCH_LOG="$DOOR_HOME/logs/rig-launch.log"

# The rig's in-container layout; the proxy (from the #182 script) uses these paths.
RIG_HOME=/tmp/agent-shim-rc-capture
HOSTS_MARKER="agent-shim rc interception rig"

# Where the container records which mode converged it; see the header for why a mixed bring-up is refused.
MODE_DIR=/opt/rc-rig
MODE_FILE=$MODE_DIR/mode

die() { printf 'rc-interception-rig: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

usage() {
  # Prints this file's own leading comment block (everything from after the shebang to the first non-comment line) as the usage text, so the header stays the single source.
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0" >&2
  exit 2
}

container_exists() { docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; }

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" = "true" ]
}

container_is_ours() {
  [ "$(docker inspect -f "{{index .Config.Labels \"$RIG_LABEL\"}}" "$CONTAINER_NAME" 2>/dev/null || true)" = "1" ]
}

recorded_mode() {
  docker exec "$CONTAINER_NAME" sh -c "cat $MODE_FILE 2>/dev/null || true"
}

port_listening() {
  docker exec "$CONTAINER_NAME" node -e '
    const net = require("node:net");
    const port = Number(process.argv[process.argv.length - 1]);
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); process.exit(0); });
    socket.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  ' "$INTERCEPT_PORT" >/dev/null 2>&1
}

rig_log_tail() {
  # The log of whichever listener the mode brings up: the proxy's own log, or the detached launch's output followed by the door's.
  if [ "$MODE" = door ]; then
    docker exec "$CONTAINER_NAME" sh -c "tail -n 20 $DOOR_LAUNCH_LOG 2>/dev/null || true; tail -n 20 $DOOR_HOME/logs/frontdoor.log 2>/dev/null || true"
  else
    docker exec "$CONTAINER_NAME" sh -c "tail -n 20 $RIG_HOME/logs/proxy.log 2>/dev/null || true"
  fi
}

wait_until() {
  # wait_until DESCRIPTION ATTEMPTS COMMAND... : polls COMMAND until it exits 0, sleeping between attempts, and dies with DESCRIPTION and the mode's log lines when the attempts run out.
  description=$1
  attempts=$2
  shift 2
  i=0
  while [ "$i" -lt "$attempts" ]; do
    if "$@"; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  printf '%s\n' "--- $DOOR_LAUNCH_LOG and $DOOR_HOME/logs/frontdoor.log (door) or $RIG_HOME/logs/proxy.log (proxy) ---"
  rig_log_tail
  die "$description"
}

ensure_container() {
  if container_exists; then
    container_is_ours || die "container $CONTAINER_NAME exists without this rig's label; refusing to adopt a container this script did not create"
    if container_running; then
      info "container $CONTAINER_NAME already running"
    else
      info "starting existing container $CONTAINER_NAME"
      docker start "$CONTAINER_NAME" >/dev/null
    fi
  else
    info "creating container $CONTAINER_NAME from $IMAGE (own network namespace, NET_ADMIN for the redirect)"
    docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
    # sleep infinity keeps the container alive without any process that would fight the rig for port 443 or hold TLS state of its own.
    docker run -d --name "$CONTAINER_NAME" --label "$RIG_LABEL=1" --cap-add NET_ADMIN "$IMAGE" sleep infinity >/dev/null
  fi
  wait_until "container $CONTAINER_NAME did not reach running state" 15 container_running
}

ensure_mode_marker() {
  # Both modes listen on the same interception port, so converging a container in the other mode would find a listener and mistake it for its own. The recorded mode refuses that; a container from before mode recording gets its first mode written now, unless something is already listening (a proxy from the pre-mode script) and the requested mode would conflict with it.
  recorded=$(recorded_mode)
  if [ -n "$recorded" ] && [ "$recorded" != "$MODE" ]; then
    die "container $CONTAINER_NAME was brought up in $recorded mode; run '$0 down' first to bring it up in $MODE mode"
  fi
  if [ -z "$recorded" ]; then
    if [ "$MODE" = door ] && port_listening; then
      die "something already listens on 127.0.0.1:$INTERCEPT_PORT in container $CONTAINER_NAME (a proxy from before mode recording); run '$0 down' first"
    fi
    docker exec "$CONTAINER_NAME" mkdir -p "$MODE_DIR"
    docker exec "$CONTAINER_NAME" sh -c "printf '%s\n' $MODE >$MODE_FILE"
    info "recorded rig mode $MODE in the container"
  fi
}

ensure_packages() {
  # Both the redirect rule and the TLS proof need these. Installed before the redirect exists: once that rule is in, every TLS host in the container except the intercepted ones is unreachable (their handshakes arrive at the terminating listener, which serves only the intercept set), which includes apt and npm.
  if docker exec "$CONTAINER_NAME" sh -c 'command -v iptables >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1'; then
    info "iptables and openssl already installed"
    return
  fi
  info "installing iptables and openssl in the container"
  docker exec -e DEBIAN_FRONTEND=noninteractive "$CONTAINER_NAME" apt-get update -qq
  docker exec -e DEBIAN_FRONTEND=noninteractive "$CONTAINER_NAME" apt-get install -y -qq iptables openssl >/dev/null
}

ensure_npm_global() {
  # ensure_npm_global BINARY PACKAGE... : check-then-act install of a global npm package, before the redirect exists for the same reason as the apt packages (the npm registry is unreachable through the interception port).
  binary=$1
  shift
  if docker exec "$CONTAINER_NAME" sh -c "command -v $binary >/dev/null 2>&1"; then
    info "$binary already installed in the container"
    return
  fi
  info "installing $* in the container"
  docker exec "$CONTAINER_NAME" npm install -g --no-fund --no-audit "$@" >/dev/null
}

ensure_proxy() {
  info "bundling the SNI proxy from this checkout into $PROXY_BUNDLE"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required on the machine running this script (it bundles scripts/rc-sni-proxy-core.mts with esbuild)"
  (cd "$REPO_ROOT" && pnpm exec esbuild scripts/rc-sni-proxy-core.mts --bundle --platform=node --format=esm --outfile="$PROXY_BUNDLE" --log-level=warning)
  [ -f "$PROXY_BUNDLE" ] || die "esbuild produced no bundle at $PROXY_BUNDLE"

  docker exec "$CONTAINER_NAME" mkdir -p /opt/rc-rig "$RIG_HOME/ca" "$RIG_HOME/logs"
  # Always refreshed: the bundle is reproducible from the checkout, so the container's copy tracks the source it was brought up from.
  docker cp "$PROXY_BUNDLE" "$CONTAINER_NAME:/opt/rc-rig/rc-sni-proxy.mjs" >/dev/null

  if port_listening; then
    info "proxy already listening on 127.0.0.1:$INTERCEPT_PORT (left running so a live capture session is not cut; pick up proxy code changes with down + up)"
    return
  fi
  info "starting the SNI proxy on 127.0.0.1:$INTERCEPT_PORT"
  docker exec -d "$CONTAINER_NAME" sh -c "node /opt/rc-rig/rc-sni-proxy.mjs >>$RIG_HOME/logs/proxy.log 2>&1"
  wait_until "the SNI proxy did not start listening on 127.0.0.1:$INTERCEPT_PORT" 15 port_listening
  wait_until "the SNI proxy did not write its CA to $RIG_HOME/ca/sni-ca.pem" 10 \
    docker exec "$CONTAINER_NAME" sh -c "test -s $RIG_HOME/ca/sni-ca.pem"
}

ensure_door() {
  if port_listening; then
    info "door already listening on 127.0.0.1:$INTERCEPT_PORT (left running; the transparent surface's own registry session keeps the door from idling out)"
    return
  fi
  # The bring-up choice, recorded in docs/rc-interception-rig.md: the door is normally started by a launch, and AGENT_SHIM_TRANSPARENT_SURFACE is read once, at door start, from the launching process's environment. A detached 'agent-shim run' is the simplest correct bring-up: --track-usage is what makes a plain OAuth launch engage the door at all, the launcher's ensure step starts the door before spawning the child, and the supervisor is detached so the door outlives the launch. AGENT_SHIM_FRONTDOOR_CAPTURE turns on the door's own capture, this rig's observation surface for the injection work; the file it writes can contain credential material.
  info "starting the front door through a detached agent-shim run (transparent surface on 127.0.0.1:$INTERCEPT_PORT, capture on)"
  docker exec -d \
    -e AGENT_SHIM_HOME="$DOOR_HOME" \
    -e AGENT_SHIM_TRANSPARENT_SURFACE="$INTERCEPT_PORT" \
    -e AGENT_SHIM_FRONTDOOR_CAPTURE=1 \
    "$CONTAINER_NAME" \
    sh -c "mkdir -p $DOOR_HOME/logs && agent-shim run @$DOOR_IDENTITY --track-usage >>$DOOR_LAUNCH_LOG 2>&1"
  wait_until "the door's transparent surface did not start listening on 127.0.0.1:$INTERCEPT_PORT" 45 port_listening
  wait_until "the door did not write its CA to $DOOR_CA" 10 \
    docker exec "$CONTAINER_NAME" sh -c "test -s $DOOR_CA"
}

ensure_door_identity() {
  if docker exec -e AGENT_SHIM_HOME="$DOOR_HOME" "$CONTAINER_NAME" agent-shim identity list 2>/dev/null | grep -Eq "^[* ]+ $DOOR_IDENTITY( |\$)"; then
    info "identity $DOOR_IDENTITY already present in $DOOR_HOME"
    return
  fi
  info "creating identity $DOOR_IDENTITY in $DOOR_HOME (empty until the manual login)"
  docker exec -e AGENT_SHIM_HOME="$DOOR_HOME" "$CONTAINER_NAME" agent-shim identity add "$DOOR_IDENTITY"
}

ensure_hosts_entries() {
  if docker exec "$CONTAINER_NAME" grep -q "$HOSTS_MARKER" /etc/hosts; then
    info "hosts entries already present"
    return
  fi
  info "writing /etc/hosts entries for the intercepted hosts"
  # Claude Code resolves via DNS-over-HTTPS on a macOS or Linux host and ignores /etc/hosts; inside this container the DoH lookup fails (the redirect rule below sends the DoH resolver's own TLS to the terminating listener, which serves only the intercepted hosts) and resolution falls back to the system resolver, where /etc/hosts works. Host-level /etc/hosts redirection is not viable; container-level is. Confirmed on the live rigs.
  docker exec "$CONTAINER_NAME" sh -c "printf '%s\n' \
    '# begin $HOSTS_MARKER' \
    '127.0.0.1 api.anthropic.com' \
    '127.0.0.1 platform.claude.com' \
    '127.0.0.1 bridge.claudeusercontent.com' \
    '127.0.0.1 claude.ai' \
    '# end $HOSTS_MARKER' >> /etc/hosts"
}

ensure_redirect() {
  # Redirect every local 443 connection to the interception port, except the terminating listener's own upstream dials (source ports $EXEMPT_SOURCE_PORTS), which would otherwise be captured and looped back through it. iptables -C is the check, -A the act, so re-runs never stack a second copy of the rule.
  if docker exec "$CONTAINER_NAME" iptables -t nat -C OUTPUT -p tcp --dport 443 '!' --sport "$EXEMPT_SOURCE_PORTS" -j REDIRECT --to-ports "$INTERCEPT_PORT" 2>/dev/null; then
    info "redirect rule already present (local 443 to $INTERCEPT_PORT, source ports $EXEMPT_SOURCE_PORTS exempt)"
    return
  fi
  info "adding the redirect rule (local 443 to $INTERCEPT_PORT, source ports $EXEMPT_SOURCE_PORTS exempt)"
  docker exec "$CONTAINER_NAME" iptables -t nat -A OUTPUT -p tcp --dport 443 '!' --sport "$EXEMPT_SOURCE_PORTS" -j REDIRECT --to-ports "$INTERCEPT_PORT"
}

print_next_steps() {
  printf '\n'
  info "rig is up: container $CONTAINER_NAME ($MODE mode)"
  if [ "$MODE" = door ]; then
    printf '  interception:   local 443 redirected to 127.0.0.1:%s, the door'"'"'s transparent surface (CA at %s)\n' "$INTERCEPT_PORT" "$DOOR_CA"
    printf '  door state:     agent-shim frontdoor status with AGENT_SHIM_HOME=%s in the container\n' "$DOOR_HOME"
    printf '  capture:        %s/logs/frontdoor-capture.jsonl (door log: %s/logs/frontdoor.log)\n' "$DOOR_HOME" "$DOOR_HOME"
  else
    printf '  interception:   local 443 redirected to 127.0.0.1:%s (per-host TLS, CA at %s/ca/sni-ca.pem)\n' "$INTERCEPT_PORT" "$RIG_HOME"
    printf '  capture:        %s/logs/frontdoor-capture.jsonl (proxy log: %s/logs/proxy.log)\n' "$RIG_HOME" "$RIG_HOME"
  fi
  printf '  prove it:       RC_RIG_MODE=%s %s verify\n' "$MODE" "$0"
  printf '  tear it down:   %s down\n' "$0"
  printf '\n'
  printf 'Manual step, deliberately not automated: RC activation needs an\n'
  printf 'interactive full-scope browser login. Setup tokens are limited to\n'
  printf 'inference scope server-side, and credential-file tokens fail the\n'
  printf 'client-side scope check. Reach it with:\n'
  if [ "$MODE" = door ]; then
    printf '  docker exec -it %s sh\n' "$CONTAINER_NAME"
    printf '  export AGENT_SHIM_HOME=%s\n' "$DOOR_HOME"
    printf '  agent-shim run @%s --track-usage\n' "$DOOR_IDENTITY"
    printf 'The launch itself fronts the session: NODE_EXTRA_CA_CERTS trusts\n'
    printf 'the door'"'"'s CA and HTTPS_PROXY rides the door'"'"'s CONNECT surface.\n'
    printf 'Then complete the browser login it opens on a machine with a\n'
    printf 'browser. verify proves the door'"'"'s termination only; a full RC\n'
    printf 'session additionally needs this login. The capture can contain\n'
    printf 'credential material: read it, then delete it.\n'
  else
    printf '  docker exec -it %s sh\n' "$CONTAINER_NAME"
    printf '  export NODE_EXTRA_CA_CERTS=%s/ca/sni-ca.pem\n' "$RIG_HOME"
    printf '  claude\n'
    printf 'then complete the browser login it opens on a machine with a browser.\n'
    printf 'Captured frames accumulate in %s/logs/frontdoor-capture.jsonl;\n' "$RIG_HOME"
    printf 'decode websocket frames offline with scripts/decode-stream-capture.mts.\n'
    printf 'The capture can contain credential material: read it, then delete it.\n'
  fi
}

cmd_up() {
  case "$CONTAINER_NAME" in
    rc-capture) die "RC_RIG_CONTAINER=rc-capture names the live reference rig on the Docker host, which this script must never touch; pick another name" ;;
  esac
  ensure_container
  ensure_mode_marker
  ensure_packages
  if [ "$MODE" = door ]; then
    # Every npm install happens before the redirect exists (see ensure_npm_global); the hosts entries precede the launch so the child resolves the intercepted names, and the door precedes the redirect so the port it aims at already listens.
    ensure_npm_global claude @anthropic-ai/claude-code
    ensure_npm_global agent-shim agent-shim
    ensure_door_identity
    ensure_hosts_entries
    ensure_door
  else
    ensure_proxy
    ensure_hosts_entries
    ensure_npm_global claude @anthropic-ai/claude-code
  fi
  ensure_redirect
  print_next_steps
}

cmd_down() {
  case "$CONTAINER_NAME" in
    rc-capture) die "RC_RIG_CONTAINER=rc-capture names the live reference rig on the Docker host, which this script must never touch; pick another name" ;;
  esac
  if ! container_exists; then
    info "nothing to remove: no container named $CONTAINER_NAME"
    return
  fi
  container_is_ours || die "container $CONTAINER_NAME exists without this rig's label; refusing to remove a container this script did not create"
  info "stopping and removing container $CONTAINER_NAME"
  docker rm -f "$CONTAINER_NAME" >/dev/null
}

cmd_status() {
  printf 'container %s: ' "$CONTAINER_NAME"
  if ! container_exists; then
    printf 'absent\n'
    exit 0
  fi
  if container_running; then printf 'running'; else printf 'stopped'; fi
  container_is_ours && printf ' (created by this rig)' || printf ' (NOT created by this rig)'
  printf '\n'
  if ! container_running; then
    exit 0
  fi
  printf 'mode (recorded in container): '
  recorded=$(recorded_mode)
  if [ -n "$recorded" ]; then printf '%s\n' "$recorded"; else printf 'none (container predates mode recording)\n'; fi
  printf 'hosts entries: '
  docker exec "$CONTAINER_NAME" grep -q "$HOSTS_MARKER" /etc/hosts 2>/dev/null && printf 'present\n' || printf 'absent\n'
  printf 'redirect rule: '
  docker exec "$CONTAINER_NAME" iptables -t nat -C OUTPUT -p tcp --dport 443 '!' --sport "$EXEMPT_SOURCE_PORTS" -j REDIRECT --to-ports "$INTERCEPT_PORT" 2>/dev/null && printf 'present\n' || printf 'absent\n'
  if [ "$MODE" = door ]; then
    printf 'door transparent surface on 127.0.0.1:%s: ' "$INTERCEPT_PORT"
    port_listening && printf 'listening\n' || printf 'not listening\n'
    printf 'agent-shim: '
    docker exec "$CONTAINER_NAME" sh -c 'command -v agent-shim >/dev/null 2>&1' && printf 'installed\n' || printf 'not installed\n'
    if docker exec "$CONTAINER_NAME" sh -c 'command -v agent-shim >/dev/null 2>&1'; then
      printf 'frontdoor status:\n'
      docker exec -e AGENT_SHIM_HOME="$DOOR_HOME" "$CONTAINER_NAME" agent-shim frontdoor status 2>/dev/null | sed 's/^/  /' || true
    fi
  else
    printf 'proxy on 127.0.0.1:%s: ' "$INTERCEPT_PORT"
    port_listening && printf 'listening\n' || printf 'not listening\n'
  fi
  printf 'Claude Code: '
  docker exec "$CONTAINER_NAME" sh -c 'command -v claude >/dev/null 2>&1' && printf 'installed\n' || printf 'not installed\n'
}

door_serves_host() {
  case " $DOOR_INTERCEPT_HOSTS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

cmd_verify() {
  container_running || die "container $CONTAINER_NAME is not running; bring the rig up first"
  recorded=$(recorded_mode)
  if [ -n "$recorded" ] && [ "$recorded" != "$MODE" ]; then
    die "container $CONTAINER_NAME is in $recorded mode; run verify with RC_RIG_MODE=$recorded"
  fi
  if [ "$MODE" = door ]; then
    ca="$DOOR_CA"
    ca_owner="the door"
  else
    ca="$RIG_HOME/ca/sni-ca.pem"
    ca_owner="the rig"
  fi
  docker exec "$CONTAINER_NAME" sh -c "test -s $ca" || die "no CA at $ca; $ca_owner has not run"
  failed=0
  for host in $INTERCEPT_HOSTS; do
    verify_line=$(docker exec "$CONTAINER_NAME" sh -c "openssl s_client -connect 127.0.0.1:443 -servername $host -verify_hostname $host -CAfile $ca -verify_return_error </dev/null 2>&1" | grep -F "Verify return code" || true)
    san_line=$(docker exec "$CONTAINER_NAME" sh -c "openssl s_client -connect 127.0.0.1:443 -servername $host </dev/null 2>/dev/null | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' | openssl x509 -noout -text 2>/dev/null" | sed -n '/Subject Alternative Name/{n;p;}' || true)
    if [ "$MODE" = door ] && ! door_serves_host "$host"; then
      # The door's transparent surface serves only its intercept set and must refuse every other redirected name with no certificate at all, rather than answer with another host's leaf. openssl still prints "Verify return code: 0 (ok)" for a handshake that read zero bytes, so the certificate's absence (an empty SAN extraction) is the refusal signal, not the verify line.
      if printf '%s' "$san_line" | grep -q "DNS:"; then
        failed=1
        printf 'FAIL %s: presented a certificate outside the door intercept set\n' "$host"
      else
        printf 'PASS %s: refused with no certificate (outside the door intercept set)\n' "$host"
      fi
      continue
    fi
    if [ "$verify_line" = "Verify return code: 0 (ok)" ] && printf '%s' "$san_line" | grep -q "DNS:$host"; then
      printf 'PASS %s: %s; %s\n' "$host" "$(printf '%s' "$san_line" | tr -s ' ')" "$verify_line"
    else
      failed=1
      printf 'FAIL %s: verification "%s"; SAN "%s"\n' "$host" "$verify_line" "$san_line"
    fi
  done
  [ "$failed" -eq 0 ] || die "per-host TLS verification failed"
  if [ "$MODE" = door ]; then
    info "the door terminated every host in its intercept set with a leaf matching its own name, verified against the door CA, and refused the rest with no certificate"
  else
    info "every intercepted host presented a leaf matching its own name, verified against the rig's CA"
  fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  verify) cmd_verify ;;
  *) usage ;;
esac
