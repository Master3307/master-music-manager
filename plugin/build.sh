#!/usr/bin/env bash
# Builds master-music-manager.ndp. Uses TinyGo if installed, else the TinyGo Docker image.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
build() { go mod tidy && tinygo build -opt=2 -no-debug -o plugin.wasm -target wasip1 -buildmode=c-shared . ; }
if command -v tinygo >/dev/null 2>&1; then build
else docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gopath -v "$PWD":/src -w /src -e GOFLAGS=-buildvcs=false tinygo/tinygo:0.44.0 bash -c "go mod tidy && tinygo build -opt=2 -no-debug -o plugin.wasm -target wasip1 -buildmode=c-shared ."
fi
rm -f master-music-manager.ndp
zip -j -q master-music-manager.ndp manifest.json plugin.wasm
echo "Built master-music-manager.ndp (version $VERSION, $(du -h plugin.wasm | cut -f1) wasm)"
