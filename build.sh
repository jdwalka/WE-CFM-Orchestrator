#!/bin/bash
set -e

PROJECT_TYPE="${1:-go}"
TARGET="${2:-linux}"

echo "==> Building ${PROJECT_TYPE} for target: ${TARGET}"

case "${PROJECT_TYPE}" in
  go)
    case "${TARGET}" in
      linux)
        GOOS=linux GOARCH=amd64 CGO_ENABLED=1 go build -o dist/app-linux-amd64 .
        ;;
      darwin|macos)
        GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o dist/app-darwin-arm64 .
        GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -o dist/app-darwin-amd64 .
        ;;
      windows)
        GOOS=windows GOARCH=amd64 CC=x86_64-w64-mingw32-gcc CGO_ENABLED=1 go build -o dist/app-windows-amd64.exe .
        ;;
      *)
        echo "Unknown target: ${TARGET}"
        exit 1
        ;;
    esac
    ;;
  rust)
    case "${TARGET}" in
      linux)
        cargo build --release --target x86_64-unknown-linux-musl
        ;;
      darwin|macos)
        cargo build --release --target aarch64-apple-darwin
        cargo build --release --target x86_64-apple-darwin
        ;;
      *)
        echo "Unknown target: ${TARGET}"
        exit 1
        ;;
    esac
    ;;
  python)
    pip install --upgrade pip build wheel
    python -m build
    ;;
  *)
    echo "Usage: build.sh <go|rust|python> <linux|darwin|windows>"
    exit 1
    ;;
esac

echo "==> Build finished successfully."
