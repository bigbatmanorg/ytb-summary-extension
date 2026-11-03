#!/bin/sh
# Build dist/ytb-summary-extension-<version>.zip: the unpacked extension, nothing else.
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
mkdir -p dist
out="dist/ytb-summary-extension-$version.zip"
rm -f "$out"
zip -qr "$out" manifest.json LICENSE src icons -x '*.DS_Store'
echo "$out"
