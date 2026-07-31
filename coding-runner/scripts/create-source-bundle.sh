#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 REPOSITORY_PATH REF [OUTPUT.bundle]" >&2
  exit 2
fi

REPOSITORY_PATH="$1"
REF="$2"
OUTPUT_PATH="${3:-source.bundle}"

if ! git -C "$REPOSITORY_PATH" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a Git repository: $REPOSITORY_PATH" >&2
  exit 1
fi

BASE_SHA="$(git -C "$REPOSITORY_PATH" rev-parse "$REF^{commit}")"
git -C "$REPOSITORY_PATH" bundle create "$OUTPUT_PATH" "$REF"
git -C "$REPOSITORY_PATH" bundle verify "$OUTPUT_PATH" >/dev/null

if command -v sha256sum >/dev/null 2>&1; then
  BUNDLE_SHA256="$(sha256sum "$OUTPUT_PATH" | awk '{print $1}')"
else
  BUNDLE_SHA256="$(shasum -a 256 "$OUTPUT_PATH" | awk '{print $1}')"
fi

echo "Bundle: $OUTPUT_PATH"
echo "baseSha: $BASE_SHA"
echo "sha256: $BUNDLE_SHA256"
