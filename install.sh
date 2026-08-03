#!/usr/bin/env bash
# Installs the hesper CLI on macOS or Linux. Safe to run as:
#   curl -fsSL https://raw.githubusercontent.com/lzvxck/hesper-code/main/install.sh | bash
# Set HESPER_VERSION=v0.1.0 to install a specific release instead of the latest one.
set -euo pipefail

REPO="lzvxck/hesper-code"
INSTALL_DIR="$HOME/.local/bin"

os="$(uname -s)"
case "$os" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) echo "hesper: unsupported operating system '$os'. Prebuilt binaries exist for macOS and Linux only." >&2; exit 1 ;;
esac

machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) cpu="x64" ;;
  arm64 | aarch64) cpu="arm64" ;;
  *) echo "hesper: unsupported architecture '$machine' on $os. Prebuilt binaries exist for x86_64 and arm64 only." >&2; exit 1 ;;
esac

asset="hesper-$platform-$cpu"
if [ -n "${HESPER_VERSION:-}" ]; then
  base_url="https://github.com/$REPO/releases/download/$HESPER_VERSION"
else
  base_url="https://github.com/$REPO/releases/latest/download"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "hesper: downloading $asset..."
curl -fsSL -o "$tmp_dir/$asset" "$base_url/$asset"
curl -fsSL -o "$tmp_dir/SHA256SUMS" "$base_url/SHA256SUMS"

# Guards against a truncated or corrupted download, not against a compromised release:
# whoever can replace the binary can replace SHA256SUMS alongside it.
expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp_dir/SHA256SUMS")"
if [ -z "$expected" ]; then
  echo "hesper: SHA256SUMS in this release does not list $asset. Aborting." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp_dir/$asset" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp_dir/$asset" | awk '{ print $1 }')"
else
  echo "hesper: neither sha256sum nor shasum is available, so the download cannot be verified. Aborting." >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  echo "hesper: checksum mismatch for $asset." >&2
  echo "  expected $expected" >&2
  echo "  got      $actual" >&2
  exit 1
fi

# Only now does anything land on PATH, so an interrupted install leaves nothing behind.
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp_dir/$asset"
mv "$tmp_dir/$asset" "$INSTALL_DIR/hesper"

echo "hesper: installed $("$INSTALL_DIR/hesper" --version) to $INSTALL_DIR/hesper"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    case "$(basename "${SHELL:-}")" in
      zsh) rc="$HOME/.zshrc" ;;
      bash) rc="$HOME/.bashrc" ;;
      *) rc="$HOME/.profile" ;;
    esac
    echo
    echo "$INSTALL_DIR is not on your PATH. Add this line to $rc, then open a new terminal:"
    echo '    export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac
