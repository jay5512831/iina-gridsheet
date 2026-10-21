#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_CLI="${IINA_PLUGIN_CLI:-/Applications/IINA.app/Contents/MacOS/iina-plugin}"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/Info.json")"
STAGE="$ROOT/build/多宫格缩略图"

rm -rf "$ROOT/build"
mkdir -p "$STAGE/src" "$STAGE/ui" "$STAGE/docs"
cp "$ROOT/Info.json" "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/"
cp "$ROOT"/src/*.js "$STAGE/src/"
cp "$ROOT/ui/window.html" "$STAGE/ui/"
cp "$ROOT/docs/preview.png" "$STAGE/docs/"

cd "$ROOT/build"
"$PLUGIN_CLI" pack "多宫格缩略图"

mkdir -p "$ROOT/dist"
mv "多宫格缩略图-${VERSION}.iinaplgz" "$ROOT/dist/GridSheet-${VERSION}.iinaplgz"
echo "built dist/GridSheet-${VERSION}.iinaplgz"
