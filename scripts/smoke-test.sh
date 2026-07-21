#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  source infra/project.env
fi
: "${INGEST_URL:?Set INGEST_URL}"
: "${ODORIK_UPLOAD_USER:?Set ODORIK_UPLOAD_USER}"
: "${ODORIK_UPLOAD_PASSWORD:?Set ODORIK_UPLOAD_PASSWORD}"

FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

say -o "$FIXTURE_DIR/call.aiff" \
  "Hello, this is a test telephone call. Please send the report to Tomas tomorrow. Thank you and goodbye."
afconvert -f WAVE -d LEI16@16000 "$FIXTURE_DIR/call.aiff" "$FIXTURE_DIR/call.wav"

curl --fail-with-body --silent --show-error \
  --user "$ODORIK_UPLOAD_USER:$ODORIK_UPLOAD_PASSWORD" \
  --form "record=@$FIXTURE_DIR/call.wav;type=audio/wav" \
  --form "callid=fixture-$(date -u +%Y%m%d-%H%M%S)" \
  --form "duration=8" \
  --form "line_name=759616 (fixture)" \
  --form "time=$(date -u '+%Y-%m-%d %H:%M:%S')" \
  --form "from=420111222333" \
  --form "to=420910122307" \
  "$INGEST_URL/odorik/recordings"
echo
