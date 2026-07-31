#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

GITHUB_WEBHOOK_SECRET_NAME="${GITHUB_WEBHOOK_SECRET_NAME:-GITHUB_WEBHOOK_SECRET}"
CONTROL_PLANE_SERVICE_ACCOUNT="${CONTROL_PLANE_SERVICE_ACCOUNT:-odorik-crm@${PROJECT_ID}.iam.gserviceaccount.com}"
ROTATE_GITHUB_WEBHOOK_SECRET="${ROTATE_GITHUB_WEBHOOK_SECRET:-0}"

secret_exists=0
if gcloud secrets describe "$GITHUB_WEBHOOK_SECRET_NAME" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  secret_exists=1
fi

if [[ "$secret_exists" -eq 0 || "$ROTATE_GITHUB_WEBHOOK_SECRET" == "1" ]]; then
  webhook_secret="$(openssl rand -hex 32)"
  if [[ "$secret_exists" -eq 1 ]]; then
    printf '%s' "$webhook_secret" | gcloud secrets versions add \
      "$GITHUB_WEBHOOK_SECRET_NAME" \
      --data-file=- \
      --project="$PROJECT_ID" >/dev/null
    echo "Created a new version of $GITHUB_WEBHOOK_SECRET_NAME."
  else
    printf '%s' "$webhook_secret" | gcloud secrets create \
      "$GITHUB_WEBHOOK_SECRET_NAME" \
      --replication-policy=automatic \
      --labels=provider=github,credential=webhook-secret \
      --data-file=- \
      --project="$PROJECT_ID" >/dev/null
    echo "Created $GITHUB_WEBHOOK_SECRET_NAME."
  fi
  unset webhook_secret
else
  echo "$GITHUB_WEBHOOK_SECRET_NAME already exists; keeping the active value."
  echo "Set ROTATE_GITHUB_WEBHOOK_SECRET=1 only when GitHub is updated in the same operation."
fi

gcloud secrets add-iam-policy-binding "$GITHUB_WEBHOOK_SECRET_NAME" \
  --member="serviceAccount:$CONTROL_PLANE_SERVICE_ACCOUNT" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null

echo "GitHub webhook secret is ready in Secret Manager."
echo "SECRET=$GITHUB_WEBHOOK_SECRET_NAME"
echo "CONSUMER=$CONTROL_PLANE_SERVICE_ACCOUNT"
echo "WEBHOOK_URL=https://agent-erik-app.web.app/webhooks/github"
echo "Retrieve the value only for the GitHub App settings:"
echo "gcloud secrets versions access latest --secret=$GITHUB_WEBHOOK_SECRET_NAME --project=$PROJECT_ID"
