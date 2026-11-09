#!/bin/sh
# Installs Household: curl -fsSL https://agents-household.dev/install.sh | sh
#
# Puts a release (house, its Codex, microsandbox, the web UI) in ~/.household/releases/<tag>, points
# ~/.household/current at it and ~/.household/bin/house at its binary. Run again to update; `house update` does the
# same. Nothing outside ~/.household is touched, and nothing needs sudo.
#
#   HOUSEHOLD_VERSION=v0.3.0   that release instead of the newest
#   HOUSEHOLD_HOME=...         another place than ~/.household
set -eu

REPO="underwear/household"
HOME_DIR="${HOUSEHOLD_HOME:-$HOME/.household}"
DOWNLOADS="${HOUSEHOLD_DOWNLOADS:-https://github.com/$REPO/releases/download}"

say() { printf '%s\n' "$*"; }
fail() { printf 'household: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1"; }
need curl
need tar

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform="darwin-arm64" ;;
  Linux-x86_64 | Linux-amd64) platform="linux-x64" ;;
  Linux-aarch64 | Linux-arm64) platform="linux-arm64" ;;
  Darwin-x86_64) fail "Household runs on Apple silicon Macs, not Intel ones" ;;
  *) fail "no Household for $(uname -s) $(uname -m): macOS on Apple silicon, or Linux on x86_64 or arm64" ;;
esac

if [ "$platform" != "darwin-arm64" ]; then
  if [ ! -e /dev/kvm ]; then
    say "! /dev/kvm is missing: bots run in microVMs and need KVM (bare metal, or a VM/VPS with nested virtualization)."
  elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    say "! /dev/kvm is not usable by $(id -un): add yourself to its group ($(stat -c %G /dev/kvm 2>/dev/null || echo kvm)), then log in again."
  fi
fi

if [ -n "${HOUSEHOLD_VERSION:-}" ]; then
  tag="$HOUSEHOLD_VERSION"
else
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || fail "could not find the newest release on GitHub"
fi

archive="household-$tag-$platform.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Household $tag for $platform"
curl -fsSL --retry 3 -o "$tmp/$archive" "$DOWNLOADS/$tag/$archive" || fail "could not download $archive"
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$DOWNLOADS/$tag/SHA256SUMS" || fail "could not download SHA256SUMS"
expected="$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)"
[ -n "$expected" ] || fail "SHA256SUMS has no line for $archive"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$archive" | cut -d ' ' -f 1)"
else actual="$(shasum -a 256 "$tmp/$archive" | cut -d ' ' -f 1)"; fi
[ "$actual" = "$expected" ] || fail "$archive does not match its checksum: not installed"

mkdir -p "$HOME_DIR/releases" "$HOME_DIR/bin"
tar -xzf "$tmp/$archive" -C "$tmp"
previous="$(readlink "$HOME_DIR/current" 2>/dev/null || true)"
rm -rf "$HOME_DIR/releases/$tag"
mv "$tmp/household-$tag-$platform" "$HOME_DIR/releases/$tag"
# A running daemon keeps the files it started from; it uses the new release once restarted.
ln -sfn "releases/$tag" "$HOME_DIR/current"
ln -sfn "../current/bin/house" "$HOME_DIR/bin/house"
# Kept: this release and the one before (to go back to); older ones go.
for old in "$HOME_DIR"/releases/*; do
  case "$old" in "$HOME_DIR/releases/$tag" | "$HOME_DIR/$previous") ;; *) rm -rf "$old" ;; esac
done

"$HOME_DIR/bin/house" --version >/dev/null || fail "the installed house does not run"
say "✓ installed in $HOME_DIR"

for tool in python3 openssl; do
  command -v "$tool" >/dev/null 2>&1 || say "! Household also needs $tool: install it (macOS: brew install $tool; Linux: your package manager)."
done

case ":$PATH:" in
  *":$HOME_DIR/bin:"*) house_cmd="house" ;;
  *)
    house_cmd="$HOME_DIR/bin/house"
    shell_rc="$HOME/.profile"
    case "${SHELL:-}" in */zsh) shell_rc="$HOME/.zshrc" ;; */bash) shell_rc="$HOME/.bashrc" ;; esac
    say ""
    say "Add house to your PATH:"
    say "  echo 'export PATH=\"$HOME_DIR/bin:\$PATH\"' >> $shell_rc && export PATH=\"$HOME_DIR/bin:\$PATH\""
    ;;
esac

say ""
say "Next: $house_cmd onboard    (a key, a Telegram bot, a bot, step by step)"
say "Running already? Restart it to use $tag: Ctrl-C and \`house start\`, or restart its service."
