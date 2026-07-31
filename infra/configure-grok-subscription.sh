#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

if ! command -v grok >/dev/null 2>&1; then
  echo "Install the Grok Build CLI before connecting the subscription." >&2
  exit 1
fi

AUTH_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/erik-grok-auth.XXXXXX")"
cleanup() {
  case "$AUTH_TMP_DIR" in
    "${TMPDIR:-/tmp}"/erik-grok-auth.*) rm -rf -- "$AUTH_TMP_DIR" ;;
    *) echo "Refusing to remove unexpected temporary directory." >&2 ;;
  esac
}
trap cleanup EXIT
chmod 0700 "$AUTH_TMP_DIR"

echo "Connecting a Grok subscription with device OAuth. No xAI API key is used."
env -u XAI_API_KEY GROK_HOME="$AUTH_TMP_DIR" grok login --device-auth

AUTH_FILE="$AUTH_TMP_DIR/auth.json"
if [[ ! -s "$AUTH_FILE" ]]; then
  echo "Grok login completed without producing auth.json." >&2
  exit 1
fi
chmod 0600 "$AUTH_FILE"

if ! gcloud secrets describe grok-subscription-auth --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets create grok-subscription-auth \
    --replication-policy=automatic \
    --labels=auth-kind=subscription-oauth,consumer=coding-runner \
    --project="$PROJECT_ID"
fi
gcloud secrets versions add grok-subscription-auth \
  --data-file="$AUTH_FILE" \
  --project="$PROJECT_ID" >/dev/null

echo "Grok subscription session stored as a new Secret Manager version."
echo "Reconnect by running this script again if a job reports attention_required authentication."
