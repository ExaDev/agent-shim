#!/bin/sh
# Remote Control interception rig (ExaDev/agent-shim#184): an idempotent, reproducible bring-up of the capture container whose hand-built ancestor captured the real CCR v2 session behind ExaDev/agent-shim#136 and #137. Re-running "up" converges the container to the desired state (check-then-act on the container, the hosts entries and the iptables rule) rather than duplicating or failing.
#
# Subcommands:
#
#   up: create/start the container if needed, install its packages, bundle and start the standalone SNI proxy, write the /etc/hosts entries, add the iptables redirect, install Claude Code, then print the manual login step.
#
#   down: stop and remove the container this script created.
#
#   status: report each piece of the desired state without changing anything.
#
#   verify: prove per-host TLS inside the container: for every intercepted host, openssl s_client against 127.0.0.1:443 must present a leaf whose SAN matches that host and verify against the rig's CA.
#
# Run from a checkout of this repo with dependencies installed (pnpm install). Every docker call honours DOCKER_HOST, so DOCKER_HOST=ssh://<host> brings the rig up on a remote Docker host; the esbuild bundling always happens on the machine running this script and only the finished bundle is copied in.
#
# The container this script owns defaults to rc-intercept-rig and carries the label below; it refuses to adopt a container without that label. rc-capture is the live reference rig on the Docker host and is never touched: that name is rejected outright.
#
# Follow-up, now unblocked: the fix for ExaDev/agent-shim#182 has landed (the door's transparent surface terminates each intercept host with its own leaf keyed on SNI), so the redirect below can be retargeted at the door's own transparent port to exercise injection and worker impersonation end to end, keeping this standalone proxy as the fallback for the raw bidirectional capture the door's tap does not expose. The exempt source-port range already matches the door's own upstream dial range (src/frontdoor/connectEffects.ts), so the same rule serves both targets. Recorded here as the documented next step; running the door inside the container is deliberately not wired up ahead of that work.
#
# The one manual step, RC activation, is printed at the end of every "up" and is deliberately not automated: it needs an interactive full-scope browser login, because setup tokens are limited to inference scope server-side and credential-file tokens fail the client-side scope check.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# Deliberately NOT rc-capture: that is the live reference rig on the Docker host and this script must never touch it.
CONTAINER_NAME=${RC_RIG_CONTAINER:-rc-intercept-rig}
IMAGE=${RC_RIG_IMAGE:-node:24-slim}
RIG_LABEL=org.exadev.agent-shim.rc-interception-rig
PROXY_BUNDLE="$REPO_ROOT/dist/rc-sni-proxy.mjs"

# The standalone SNI proxy's listen port (scripts/rc-sni-proxy-core.mts names the same port) and the redirect target.
PROXY_PORT=47472

# Source ports the proxy's own upstream dials leave through, excluded from the redirect so the dial cannot be captured and looped back through the proxy. This is the door's own upstream dial range (src/frontdoor/connectEffects.ts), kept identical so the rule needs no change when the redirect is retargeted at the door's transparent port (see the header follow-up note).
EXEMPT_SOURCE_PORTS=47900:47919

# The four Anthropic hosts that share one address; scripts/rc-sni-proxy-core.mts mints one leaf per host from the same list.
INTERCEPT_HOSTS="api.anthropic.com platform.claude.com bridge.claudeusercontent.com claude.ai"

# The rig's in-container layout; the proxy (from the #182 script) uses these paths.
RIG_HOME=/tmp/agent-shim-rc-capture
HOSTS_MARKER="agent-shim rc interception rig"

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

proxy_listening() {
  docker exec "$CONTAINER_NAME" node -e '
    const net = require("node:net");
    const port = Number(process.argv[process.argv.length - 1]);
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); process.exit(0); });
    socket.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  ' "$PROXY_PORT" >/dev/null 2>&1
}

proxy_log_tail() {
  docker exec "$CONTAINER_NAME" sh -c "tail -n 20 $RIG_HOME/logs/proxy.log 2>/dev/null || true"
}

wait_until() {
  # wait_until DESCRIPTION ATTEMPTS COMMAND... : polls COMMAND until it exits 0, sleeping between attempts, and dies with DESCRIPTION and the last log lines when the attempts run out.
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
  printf '%s\n' "--- $RIG_HOME/logs/proxy.log ---"
  proxy_log_tail
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

ensure_packages() {
  # Both the redirect rule and the TLS proof need these. Installed before the redirect exists: once that rule is in, every TLS host in the container except the four intercepted ones is unreachable (their handshakes arrive at the proxy, which serves only those four), which includes apt and npm.
  if docker exec "$CONTAINER_NAME" sh -c 'command -v iptables >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1'; then
    info "iptables and openssl already installed"
    return
  fi
  info "installing iptables and openssl in the container"
  docker exec -e DEBIAN_FRONTEND=noninteractive "$CONTAINER_NAME" apt-get update -qq
  docker exec -e DEBIAN_FRONTEND=noninteractive "$CONTAINER_NAME" apt-get install -y -qq iptables openssl >/dev/null
}

ensure_proxy() {
  info "bundling the SNI proxy from this checkout into $PROXY_BUNDLE"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required on the machine running this script (it bundles scripts/rc-sni-proxy-core.mts with esbuild)"
  (cd "$REPO_ROOT" && pnpm exec esbuild scripts/rc-sni-proxy-core.mts --bundle --platform=node --format=esm --outfile="$PROXY_BUNDLE" --log-level=warning)
  [ -f "$PROXY_BUNDLE" ] || die "esbuild produced no bundle at $PROXY_BUNDLE"

  docker exec "$CONTAINER_NAME" mkdir -p /opt/rc-rig "$RIG_HOME/ca" "$RIG_HOME/logs"
  # Always refreshed: the bundle is reproducible from the checkout, so the container's copy tracks the source it was brought up from.
  docker cp "$PROXY_BUNDLE" "$CONTAINER_NAME:/opt/rc-rig/rc-sni-proxy.mjs" >/dev/null

  if proxy_listening; then
    info "proxy already listening on 127.0.0.1:$PROXY_PORT (left running so a live capture session is not cut; pick up proxy code changes with down + up)"
    return
  fi
  info "starting the SNI proxy on 127.0.0.1:$PROXY_PORT"
  docker exec -d "$CONTAINER_NAME" sh -c "node /opt/rc-rig/rc-sni-proxy.mjs >>$RIG_HOME/logs/proxy.log 2>&1"
  wait_until "the SNI proxy did not start listening on 127.0.0.1:$PROXY_PORT" 15 proxy_listening
  wait_until "the SNI proxy did not write its CA to $RIG_HOME/ca/sni-ca.pem" 10 \
    docker exec "$CONTAINER_NAME" sh -c "test -s $RIG_HOME/ca/sni-ca.pem"
}

ensure_hosts_entries() {
  if docker exec "$CONTAINER_NAME" grep -q "$HOSTS_MARKER" /etc/hosts; then
    info "hosts entries already present"
    return
  fi
  info "writing /etc/hosts entries for the intercepted hosts"
  # Claude Code resolves via DNS-over-HTTPS on a macOS or Linux host and ignores /etc/hosts; inside this container the DoH lookup fails (the redirect rule below sends the DoH resolver's own TLS to this rig's proxy, which serves only the four intercepted hosts) and resolution falls back to the system resolver, where /etc/hosts works. Host-level /etc/hosts redirection is not viable; container-level is. Confirmed on the live rigs.
  docker exec "$CONTAINER_NAME" sh -c "printf '%s\n' \
    '# begin $HOSTS_MARKER' \
    '127.0.0.1 api.anthropic.com' \
    '127.0.0.1 platform.claude.com' \
    '127.0.0.1 bridge.claudeusercontent.com' \
    '127.0.0.1 claude.ai' \
    '# end $HOSTS_MARKER' >> /etc/hosts"
}

ensure_redirect() {
  # Redirect every local 443 connection to the proxy, except the proxy's own upstream dials (source ports $EXEMPT_SOURCE_PORTS), which would otherwise be captured and looped through the proxy. iptables -C is the check, -A the act, so re-runs never stack a second copy of the rule.
  if docker exec "$CONTAINER_NAME" iptables -t nat -C OUTPUT -p tcp --dport 443 '!' --sport "$EXEMPT_SOURCE_PORTS" -j REDIRECT --to-ports "$PROXY_PORT" 2>/dev/null; then
    info "redirect rule already present (local 443 to $PROXY_PORT, source ports $EXEMPT_SOURCE_PORTS exempt)"
    return
  fi
  info "adding the redirect rule (local 443 to $PROXY_PORT, source ports $EXEMPT_SOURCE_PORTS exempt)"
  docker exec "$CONTAINER_NAME" iptables -t nat -A OUTPUT -p tcp --dport 443 '!' --sport "$EXEMPT_SOURCE_PORTS" -j REDIRECT --to-ports "$PROXY_PORT"
}

ensure_claude_code() {
  # Also installed before the redirect exists, for the same reason as the packages: the npm registry is unreachable through the proxy.
  if docker exec "$CONTAINER_NAME" sh -c 'command -v claude >/dev/null 2>&1'; then
    info "Claude Code already installed in the container"
    return
  fi
  info "installing Claude Code in the container"
  docker exec "$CONTAINER_NAME" npm install -g --no-fund --no-audit @anthropic-ai/claude-code >/dev/null
}

print_next_steps() {
  printf '\n'
  info "rig is up: container $CONTAINER_NAME"
  printf '  interception:   local 443 redirected to 127.0.0.1:%s (per-host TLS, CA at %s/ca/sni-ca.pem)\n' "$PROXY_PORT" "$RIG_HOME"
  printf '  capture:        %s/logs/frontdoor-capture.jsonl (proxy log: %s/logs/proxy.log)\n' "$RIG_HOME" "$RIG_HOME"
  printf '  prove it:       %s verify\n' "$0"
  printf '  tear it down:   %s down\n' "$0"
  printf '\n'
  printf 'Manual step, deliberately not automated: RC activation needs an\n'
  printf 'interactive full-scope browser login. Setup tokens are limited to\n'
  printf 'inference scope server-side, and credential-file tokens fail the\n'
  printf 'client-side scope check. Reach it with:\n'
  printf '  docker exec -it %s sh\n' "$CONTAINER_NAME"
  printf '  export NODE_EXTRA_CA_CERTS=%s/ca/sni-ca.pem\n' "$RIG_HOME"
  printf '  claude\n'
  printf 'then complete the browser login it opens on a machine with a browser.\n'
  printf 'Captured frames accumulate in %s/logs/frontdoor-capture.jsonl;\n' "$RIG_HOME"
  printf 'decode websocket frames offline with scripts/decode-stream-capture.mts.\n'
  printf 'The capture can contain credential material: read it, then delete it.\n'
}

cmd_up() {
  case "$CONTAINER_NAME" in
    rc-capture) die "RC_RIG_CONTAINER=rc-capture names the live reference rig on the Docker host, which this script must never touch; pick another name" ;;
  esac
  ensure_container
  ensure_packages
  ensure_proxy
  ensure_hosts_entries
  ensure_claude_code
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
  printf 'hosts entries: '
  docker exec "$CONTAINER_NAME" grep -q "$HOSTS_MARKER" /etc/hosts 2>/dev/null && printf 'present\n' || printf 'absent\n'
  printf 'redirect rule: '
  docker exec "$CONTAINER_NAME" iptables -t nat -C OUTPUT -p tcp --dport 443 '!' --sport "$EXEMPT_SOURCE_PORTS" -j REDIRECT --to-ports "$PROXY_PORT" 2>/dev/null && printf 'present\n' || printf 'absent\n'
  printf 'proxy on 127.0.0.1:%s: ' "$PROXY_PORT"
  proxy_listening && printf 'listening\n' || printf 'not listening\n'
  printf 'Claude Code: '
  docker exec "$CONTAINER_NAME" sh -c 'command -v claude >/dev/null 2>&1' && printf 'installed\n' || printf 'not installed\n'
}

cmd_verify() {
  container_running || die "container $CONTAINER_NAME is not running; bring the rig up first"
  docker exec "$CONTAINER_NAME" sh -c "test -s $RIG_HOME/ca/sni-ca.pem" || die "no CA at $RIG_HOME/ca/sni-ca.pem; the proxy has not run"
  failed=0
  for host in $INTERCEPT_HOSTS; do
    verify_line=$(docker exec "$CONTAINER_NAME" sh -c "openssl s_client -connect 127.0.0.1:443 -servername $host -verify_hostname $host -CAfile $RIG_HOME/ca/sni-ca.pem -verify_return_error </dev/null 2>&1" | grep -F "Verify return code" || true)
    san_line=$(docker exec "$CONTAINER_NAME" sh -c "openssl s_client -connect 127.0.0.1:443 -servername $host </dev/null 2>/dev/null | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' | openssl x509 -noout -text" | sed -n '/Subject Alternative Name/{n;p;}' || true)
    if [ "$verify_line" = "Verify return code: 0 (ok)" ] && printf '%s' "$san_line" | grep -q "DNS:$host"; then
      printf 'PASS %s: %s; %s\n' "$host" "$(printf '%s' "$san_line" | tr -s ' ')" "$verify_line"
    else
      failed=1
      printf 'FAIL %s: verification "%s"; SAN "%s"\n' "$host" "$verify_line" "$san_line"
    fi
  done
  [ "$failed" -eq 0 ] || die "per-host TLS verification failed"
  info "every intercepted host presented a leaf matching its own name, verified against the rig's CA"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  verify) cmd_verify ;;
  *) usage ;;
esac
