#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

GROK_AUTH_SERVICE_ACCOUNT_NAME="${GROK_AUTH_SERVICE_ACCOUNT_NAME:-erik-grok-auth}"
GROK_AUTH_SERVICE_ACCOUNT="${GROK_AUTH_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
GROK_AUTH_SECRET_NAME="${GROK_AUTH_SECRET_NAME:-grok-subscription-auth}"

for value in "$PROJECT_ID" "$GROK_AUTH_SERVICE_ACCOUNT_NAME" "$GROK_AUTH_SECRET_NAME"; do
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9.-]*$ ]]; then
    echo "Unsafe bootstrap identifier: $value" >&2
    exit 1
  fi
done

gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  --project="$PROJECT_ID"

if ! gcloud iam service-accounts describe "$GROK_AUTH_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$GROK_AUTH_SERVICE_ACCOUNT_NAME" \
    --display-name="Agent Erik Grok subscription authorizer" \
    --description="Runs xAI device OAuth and rotates only the Grok subscription secret" \
    --project="$PROJECT_ID"
fi

if ! gcloud secrets describe "$GROK_AUTH_SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets create "$GROK_AUTH_SECRET_NAME" \
    --replication-policy=automatic \
    --labels=auth-kind=subscription-oauth,consumer=coding-runner \
    --project="$PROJECT_ID"
fi

gcloud secrets add-iam-policy-binding "$GROK_AUTH_SECRET_NAME" \
  --member="serviceAccount:$GROK_AUTH_SERVICE_ACCOUNT" \
  --role=roles/secretmanager.secretVersionManager \
  --project="$PROJECT_ID" >/dev/null

gcloud secrets add-iam-policy-binding "$GROK_AUTH_SECRET_NAME" \
  --member="serviceAccount:$GROK_AUTH_SERVICE_ACCOUNT" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null

echo "Grok auth worker bootstrap complete."
echo "GROK_AUTH_SERVICE_ACCOUNT=$GROK_AUTH_SERVICE_ACCOUNT"
echo "GROK_AUTH_SECRET_NAME=$GROK_AUTH_SECRET_NAME"
echo "The worker can read, rotate, list, and disable versions of this secret only."
