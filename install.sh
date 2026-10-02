#!/usr/bin/env sh
set -eu

# Downloads the latest GitHub Release SEA binary for the running platform and installs it as `claude-use` in ~/.local/bin (or $CLAUDE_USE_INSTALL_DIR, if set). That's the only thing this script ever does to your PATH -- it never touches the `claude` command. `claude-use run [args...]` reaches the exact same launcher pipeline a `claude`-named binary would, so nothing further is needed to use every feature this tool has. If you'd also like the shorter `claude @<name>` form, run `claude-use shim enable` yourself afterward -- an explicit, separate, reversible step (`claude-use shim disable` undoes it), not something installation does for you.
#
# macOS and Linux only: this is a POSIX shell script, and Windows has no `sh` to pipe it into. Windows users get the same two commands via Scoop instead — see the README's Install section.
#
# One exception to "downloads a self-contained SEA binary": macOS x64's SEA binary segfaults on every invocation, a known and deliberately unfixed upstream Node bug (see https://github.com/ExaDev/claude-use#build-node-sea for the confirmed root cause and citations). This script installs via npm instead on that one architecture, matching the Homebrew formula's own workaround for the same problem -- which means it needs Node.js already available there, unlike every other platform/architecture this script supports.

repo="ExaDev/claude-use"

install_dir="${CLAUDE_USE_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
target="$install_dir/claude-use"

os=$(uname -s)
arch=$(uname -m)

if [ "$os" = "Darwin" ] && [ "$arch" = "x86_64" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "error: claude-use's macOS x64 binary is currently broken (a known, unfixed upstream Node bug -- see https://github.com/ExaDev/claude-use#build-node-sea)." >&2
    echo "Install Node.js first (nodejs.org, or a version manager), then re-run this script -- or use Homebrew instead, which handles this automatically:" >&2
    echo "  brew install ExaDev/claude-use/claude-use" >&2
    exit 1
  fi
  npm_prefix=$(mktemp -d)
  trap 'rm -rf "$npm_prefix"' EXIT
  echo "macOS x64's SEA binary is currently broken upstream (see https://github.com/ExaDev/claude-use#build-node-sea) -- installing via npm instead..."
  # Every other platform installs the release GitHub calls latest, so this one installs exactly that version rather than npm's `latest` dist-tag: right after a publish the registry's metadata can still name the previous release as latest, and a bare `npm install claude-use` then installs it (confirmed in this project's own post-release verification, which installed the previous version). Naming the version also lets the retry below cover the version not being resolvable yet.
  release_url=$(curl -fsSIL --retry 3 -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
  version="${release_url##*/v}"
  case "$version" in
    [0-9]*) ;;
    *) echo "error: could not read the latest release version from $release_url" >&2; exit 1 ;;
  esac
  # The npm registry's own package metadata (what `npm install` resolves a version against) and the tarball blob it then fetches are served from different backing stores, and the metadata can go live before the tarball does -- confirmed directly: right after this project's own CI published a release, the registry already listed and resolved the new version, but downloading its tarball kept 404ing for several minutes. A user running this script in that same window would otherwise see a hard, unrecoverable failure for a release that is, from every other angle, already fully published. Retry rather than fail on the first attempt.
  npm_install_attempt=1
  until npm install --global --silent --no-fund --no-audit --prefix="$npm_prefix" "claude-use@$version"; do
    if [ "$npm_install_attempt" -ge 40 ]; then
      echo "error: npm still can't fetch claude-use@$version after $npm_install_attempt attempts -- this is likely a genuine npm registry problem, not a transient propagation delay. Try again shortly, or use Homebrew instead: brew install ExaDev/claude-use/claude-use" >&2
      exit 1
    fi
    echo "npm registry not ready yet, retrying in 15s... ($npm_install_attempt/40)"
    npm_install_attempt=$((npm_install_attempt + 1))
    sleep 15
  done
  rm -f "$target"
  cp -L "$npm_prefix/bin/claude-use" "$target"
  chmod +x "$target"
  echo "installed $target"
  echo
  echo "Want a \`claude\` command too? Run: $target shim enable"
  exit 0
fi

case "$os" in
  Darwin)
    case "$arch" in
      arm64) asset="claude-use-macos-arm64" ;;
      *) echo "error: unsupported macOS architecture '$arch'" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      aarch64 | arm64) asset="claude-use-linux-arm64" ;;
      x86_64) asset="claude-use-linux-x64" ;;
      *) echo "error: unsupported Linux architecture '$arch'" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "error: unsupported platform '$os'. On Windows, use Scoop instead:" >&2
    echo "  scoop bucket add claude-use https://github.com/ExaDev/scoop-claude-use" >&2
    echo "  scoop install claude-use" >&2
    exit 1
    ;;
esac

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

base_url="https://github.com/$repo/releases/latest/download"
echo "Downloading $asset..."
curl -fsSL --retry 3 -o "$tmp_dir/$asset" "$base_url/$asset"
curl -fsSL --retry 3 -o "$tmp_dir/$asset.sha256" "$base_url/$asset.sha256"

expected_sha=$(awk '{print $1}' "$tmp_dir/$asset.sha256")
if command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$tmp_dir/$asset" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$tmp_dir/$asset" | awk '{print $1}')
else
  echo "error: neither shasum nor sha256sum is available to verify the download" >&2
  exit 1
fi
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "error: checksum mismatch for $asset (expected $expected_sha, got $actual_sha)" >&2
  exit 1
fi

chmod +x "$tmp_dir/$asset"

rm -f "$target"
if ln "$tmp_dir/$asset" "$target" 2>/dev/null; then
  :
else
  # Cross-device or otherwise hardlink-incapable filesystem: fall back to a plain copy.
  cp "$tmp_dir/$asset" "$target"
  chmod 755 "$target"
fi
echo "installed $target"

echo
echo "Want a \`claude\` command too? Run: $target shim enable"
