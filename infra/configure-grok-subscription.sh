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

echo "Break-glass operator login: the normal connection path is Sources → Grok subscription."
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
NEW_VERSION="$(gcloud secrets versions add grok-subscription-auth \
  --data-file="$AUTH_FILE" \
  --format='value(name)' \
  --project="$PROJECT_ID")"

while IFS= read -r version; do
  if [[ -n "$version" && "$version" != "$NEW_VERSION" ]]; then
    gcloud secrets versions disable "$version" \
      --secret=grok-subscription-auth \
      --project="$PROJECT_ID" >/dev/null
  fi
done < <(gcloud secrets versions list grok-subscription-auth \
  --filter='state=ENABLED' \
  --format='value(name)' \
  --project="$PROJECT_ID")

echo "Grok subscription session stored as a new Secret Manager version."
echo "The previous enabled versions were disabled. Use Sources for future reconnects."
