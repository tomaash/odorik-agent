#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

CODING_REGION="${CODING_REGION:-europe-west1}"
CODING_REPOSITORY="${CODING_ARTIFACT_REPOSITORY:-erik-coding}"
CODING_BUCKET="${CODING_ARTIFACT_BUCKET:-${PROJECT_ID}-coding-artifacts-euw1}"
CODING_SERVICE_ACCOUNT_NAME="${CODING_SERVICE_ACCOUNT_NAME:-erik-coding-runner}"
CODING_SERVICE_ACCOUNT="${CODING_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CODING_SIGNER_SERVICE_ACCOUNT_NAME="${CODING_SIGNER_SERVICE_ACCOUNT_NAME:-erik-coding-signer}"
CODING_SIGNER_SERVICE_ACCOUNT="${CODING_SIGNER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CONTROL_PLANE_SERVICE_ACCOUNT="${CONTROL_PLANE_SERVICE_ACCOUNT:-odorik-crm@${PROJECT_ID}.iam.gserviceaccount.com}"

if [[ "$CODING_REGION" != "europe-west1" ]]; then
  echo "CODING_REGION must be europe-west1 while Cloud Run ephemeral disk is in Preview." >&2
  exit 1
fi

gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  --project="$PROJECT_ID"

if ! gcloud artifacts repositories describe "$CODING_REPOSITORY" \
  --location="$CODING_REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$CODING_REPOSITORY" \
    --repository-format=docker \
    --location="$CODING_REGION" \
    --description="Agent Erik isolated coding runner images" \
    --project="$PROJECT_ID"
fi

if ! gcloud storage buckets describe "gs://$CODING_BUCKET" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$CODING_BUCKET" \
    --location="$CODING_REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --project="$PROJECT_ID"
fi
gcloud storage buckets update "gs://$CODING_BUCKET" \
  --lifecycle-file=infra/coding-artifacts-lifecycle.json \
  --project="$PROJECT_ID"

if ! gcloud iam service-accounts describe "$CODING_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$CODING_SERVICE_ACCOUNT_NAME" \
    --display-name="Agent Erik coding runner" \
    --description="Runs untrusted repository work without GitHub write or Firestore access" \
    --project="$PROJECT_ID"
fi

if ! gcloud iam service-accounts describe "$CODING_SIGNER_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$CODING_SIGNER_SERVICE_ACCOUNT_NAME" \
    --display-name="Agent Erik coding URL signer" \
    --description="Signs short-lived coding source and result URLs; never runs repository code" \
    --project="$PROJECT_ID"
fi

SIGNER_BUCKET_BINDING_READY=false
for _ in {1..10}; do
  if gcloud storage buckets add-iam-policy-binding "gs://$CODING_BUCKET" \
    --member="serviceAccount:$CODING_SIGNER_SERVICE_ACCOUNT" \
    --role=roles/storage.objectAdmin \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    SIGNER_BUCKET_BINDING_READY=true
    break
  fi
  sleep 2
done
if [[ "$SIGNER_BUCKET_BINDING_READY" != true ]]; then
  echo "The coding signer was created, but its bucket IAM binding did not become ready." >&2
  exit 1
fi

if gcloud iam service-accounts describe "$CONTROL_PLANE_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts add-iam-policy-binding "$CODING_SIGNER_SERVICE_ACCOUNT" \
    --member="serviceAccount:$CONTROL_PLANE_SERVICE_ACCOUNT" \
    --role=roles/iam.serviceAccountTokenCreator \
    --project="$PROJECT_ID" >/dev/null
else
  echo "Control-plane service account not found; skipping coding URL signer delegation." >&2
fi

if ! gcloud secrets describe grok-subscription-auth --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets create grok-subscription-auth \
    --replication-policy=automatic \
    --labels=auth-kind=subscription-oauth,consumer=coding-runner \
    --project="$PROJECT_ID"
fi

gcloud secrets add-iam-policy-binding grok-subscription-auth \
  --member="serviceAccount:$CODING_SERVICE_ACCOUNT" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null

echo "Coding runner bootstrap complete."
echo "CODING_REGION=$CODING_REGION"
echo "CODING_ARTIFACT_REPOSITORY=$CODING_REPOSITORY"
echo "CODING_ARTIFACT_BUCKET=$CODING_BUCKET"
echo "CODING_SERVICE_ACCOUNT=$CODING_SERVICE_ACCOUNT"
echo "CODING_SIGNER_SERVICE_ACCOUNT=$CODING_SIGNER_SERVICE_ACCOUNT"
echo "Next: infra/configure-grok-subscription.sh"
