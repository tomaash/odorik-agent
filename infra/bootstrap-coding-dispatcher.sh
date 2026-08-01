#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

CODING_REGION="${CODING_REGION:-europe-west1}"
CODING_RUNNER_JOB="${CODING_JOB:-erik-coding-runner}"
DISPATCHER_JOB="${CODING_DISPATCHER_JOB:-erik-coding-dispatcher}"
DISPATCHER_SERVICE_ACCOUNT_NAME="${CODING_DISPATCHER_SERVICE_ACCOUNT_NAME:-erik-coding-dispatcher}"
DISPATCHER_SERVICE_ACCOUNT="${DISPATCHER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CODING_SIGNER_SERVICE_ACCOUNT_NAME="${CODING_SIGNER_SERVICE_ACCOUNT_NAME:-erik-coding-signer}"
CODING_SIGNER_SERVICE_ACCOUNT="${CODING_SIGNER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CONTROL_PLANE_SERVICE_ACCOUNT="${CONTROL_PLANE_SERVICE_ACCOUNT:-odorik-crm@${PROJECT_ID}.iam.gserviceaccount.com}"

if [[ "$CODING_REGION" != "europe-west1" ]]; then
  echo "CODING_REGION must be europe-west1 while the coding runner disk is in Preview." >&2
  exit 1
fi

if ! gcloud iam service-accounts describe "$DISPATCHER_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$DISPATCHER_SERVICE_ACCOUNT_NAME" \
    --display-name="Agent Erik coding dispatcher" \
    --description="Packages approved GitHub source and publishes validated result branches and draft PRs" \
    --project="$PROJECT_ID"
fi

DISPATCHER_SECRET_BINDING_READY=false
for _ in {1..10}; do
  if gcloud secrets add-iam-policy-binding GITHUB_APP_PRIVATE_KEY \
    --member="serviceAccount:$DISPATCHER_SERVICE_ACCOUNT" \
    --role=roles/secretmanager.secretAccessor \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    DISPATCHER_SECRET_BINDING_READY=true
    break
  fi
  sleep 2
done
if [[ "$DISPATCHER_SECRET_BINDING_READY" != true ]]; then
  echo "The dispatcher was created, but its GitHub secret binding did not become ready." >&2
  exit 1
fi

DISPATCHER_SIGNER_BINDING_READY=false
for _ in {1..10}; do
  if gcloud iam service-accounts add-iam-policy-binding "$CODING_SIGNER_SERVICE_ACCOUNT" \
    --member="serviceAccount:$DISPATCHER_SERVICE_ACCOUNT" \
    --role=roles/iam.serviceAccountTokenCreator \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    DISPATCHER_SIGNER_BINDING_READY=true
    break
  fi
  sleep 2
done
if [[ "$DISPATCHER_SIGNER_BINDING_READY" != true ]]; then
  echo "The dispatcher was created, but its coding signer binding did not become ready." >&2
  exit 1
fi

gcloud run jobs add-iam-policy-binding "$CODING_RUNNER_JOB" \
  --member="serviceAccount:$DISPATCHER_SERVICE_ACCOUNT" \
  --role=roles/run.jobsExecutorWithOverrides \
  --region="$CODING_REGION" \
  --project="$PROJECT_ID" >/dev/null

if gcloud run jobs describe "$DISPATCHER_JOB" \
  --region="$CODING_REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud run jobs add-iam-policy-binding "$DISPATCHER_JOB" \
    --member="serviceAccount:$CONTROL_PLANE_SERVICE_ACCOUNT" \
    --role=roles/run.jobsExecutorWithOverrides \
    --region="$CODING_REGION" \
    --project="$PROJECT_ID" >/dev/null
fi

echo "Coding dispatcher IAM bootstrap complete."
echo "DISPATCHER_SERVICE_ACCOUNT=$DISPATCHER_SERVICE_ACCOUNT"
echo "FIRESTORE_ACCESS=none"
echo "GROK_SECRET_ACCESS=none"
