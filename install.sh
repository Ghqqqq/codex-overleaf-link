#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CODEX_OVERLEAF_REPO_URL:-https://github.com/Ghqqqq/codex-overleaf-link.git}"
REF="${CODEX_OVERLEAF_REF:-main}"
INSTALL_DIR="${CODEX_OVERLEAF_INSTALL_DIR:-$HOME/.codex-overleaf/source}"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_command git
need_command node
need_command npm

echo "CODEX_OVERLEAF_REF: $REF"

node - "$INSTALL_DIR" "$HOME" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(process.argv[2] || '');
const home = path.resolve(process.argv[3] || '');
const relative = path.relative(home, target);
if (!target || target === home || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error('Refusing unsafe install directory: ' + target);
}
let current = home;
for (const part of relative.split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
    throw new Error('Refusing install directory containing a symlink: ' + current);
  }
}
NODE

mkdir -p "$(dirname "$INSTALL_DIR")"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating Codex Overleaf Link in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
  git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD >/dev/null
else
  echo "Installing Codex Overleaf Link into $INSTALL_DIR"
  if [ -e "$INSTALL_DIR" ]; then
    echo "Refusing to replace an existing unmarked source directory: $INSTALL_DIR" >&2
    echo "Move or delete that directory manually, then re-run the installer." >&2
    exit 1
  fi
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
  git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD >/dev/null
fi

(
  cd "$INSTALL_DIR"
  npm ci
  npm run build:content
)

PACKAGE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" | head -n 1)"
if [ -z "$PACKAGE_VERSION" ]; then
  PACKAGE_VERSION="unknown"
fi

if [ -n "${CODEX_OVERLEAF_EXTENSION_ID:-}" ]; then
  MANAGED_RESULT="$(node "$INSTALL_DIR/scripts/install-managed.mjs" --extension-id "$CODEX_OVERLEAF_EXTENSION_ID" "$@" --json)"
else
  MANAGED_RESULT="$(node "$INSTALL_DIR/scripts/install-managed.mjs" "$@" --json)"
fi

EXTENSION_DIR="$(printf '%s\n' "$MANAGED_RESULT" | sed -n 's/.*"extensionRoot"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$EXTENSION_DIR" ]; then
  echo "Managed installer did not return an extension path." >&2
  exit 1
fi
VISIBLE_EXTENSION_DIR="${CODEX_OVERLEAF_EXTENSION_LINK:-$HOME/Codex Overleaf Link Extension}"
LOAD_UNPACKED_PATH="$EXTENSION_DIR"

if [ -L "$VISIBLE_EXTENSION_DIR" ]; then
  rm "$VISIBLE_EXTENSION_DIR"
fi

if [ ! -e "$VISIBLE_EXTENSION_DIR" ]; then
  ln -s "$EXTENSION_DIR" "$VISIBLE_EXTENSION_DIR"
  LOAD_UNPACKED_PATH="$VISIBLE_EXTENSION_DIR"
else
  echo "Could not create visible extension shortcut because this path already exists:" >&2
  echo "  $VISIBLE_EXTENSION_DIR" >&2
  echo "Use the real extension directory instead:" >&2
  echo "  $EXTENSION_DIR" >&2
fi

COPIED_EXTENSION_PATH=0
if command -v pbcopy >/dev/null 2>&1; then
  printf "%s" "$LOAD_UNPACKED_PATH" | pbcopy >/dev/null 2>&1 && COPIED_EXTENSION_PATH=1
fi

echo
echo "Codex Overleaf Link managed extension and native host are installed."
echo "Package version: $PACKAGE_VERSION"
echo "Extension path: $EXTENSION_DIR"
echo
echo "Chrome extension setup:"
echo "  Chrome does not allow scripts to load unpacked extensions automatically."
echo "  In the Chrome extensions page, enable Developer mode, click Load unpacked, then choose:"
echo "  $LOAD_UNPACKED_PATH"
if [ "$COPIED_EXTENSION_PATH" = "1" ]; then
  echo "  This folder path has also been copied to your clipboard."
fi
echo
echo "Next steps:"
echo "  1. Reload the Chrome extension in chrome://extensions."
echo "  2. Refresh the Overleaf page."

if command -v open >/dev/null 2>&1; then
  open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || open "chrome://extensions" >/dev/null 2>&1 || true
  open -R "$LOAD_UNPACKED_PATH" >/dev/null 2>&1 || true
fi
