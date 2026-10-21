#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS="$HOME/Library/Application Support/com.colliderli.iina/plugins"
DEST="$PLUGINS/io.github.jay5512831.gridsheet.iinaplugin"
PKG="$(ls "$ROOT"/dist/GridSheet-*.iinaplgz 2>/dev/null | sort -V | tail -1 || true)"

if [ -z "$PKG" ]; then
  echo "没有找到 dist/GridSheet-*.iinaplgz，请先运行 ./scripts/package.sh" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ditto -x -k "$PKG" "$TMP"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$TMP"/* "$DEST"/

defaults write com.colliderli.iina "PluginEnabled.io.github.jay5512831.gridsheet" -bool true

killall IINA 2>/dev/null || true
sleep 1
open -a IINA

echo "已安装：$DEST"
echo "版本：$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DEST/Info.json")"
