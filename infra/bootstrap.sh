#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${BILLING_ACCOUNT:?Set BILLING_ACCOUNT (ID or billingAccounts/ID)}"

REGION="${REGION:-europe-west3}"
DATABASE_ID="${FIRESTORE_DATABASE_ID:-odorik}"
BUCKET="${RECORDINGS_BUCKET:-${PROJECT_ID}-recordings}"
REPOSITORY="${ARTIFACT_REPOSITORY:-odorik}"

if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Odorik Transcription"
fi

gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"

gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbilling.googleapis.com \
  cloudbuild.googleapis.com \
  cloudresourcemanager.googleapis.com \
  eventarc.googleapis.com \
  firestore.googleapis.com \
  iam.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  pubsub.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  serviceusage.googleapis.com \
  storage.googleapis.com \
  --project="$PROJECT_ID"

if ! gcloud firestore databases describe --database="$DATABASE_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud firestore databases create \
    --database="$DATABASE_ID" \
    --edition=enterprise \
    --type=firestore-native \
    --location="$REGION" \
    --enable-firestore-data-access \
    --enable-pitr \
    --delete-protection \
    --project="$PROJECT_ID"
fi

if ! gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --project="$PROJECT_ID"
fi

gcloud storage buckets update "gs://$BUCKET" \
  --lifecycle-file=infra/storage-lifecycle.json \
  --project="$PROJECT_ID"

if ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Odorik transcription containers" \
    --project="$PROJECT_ID"
fi

for account in odorik-api odorik-ingest odorik-processor; do
  if ! gcloud iam service-accounts describe "$account@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$account" \
      --display-name="$account" \
      --project="$PROJECT_ID"
  fi
done

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:odorik-api@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user" \
  --condition=None >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:odorik-ingest@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user" \
  --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:odorik-ingest@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectCreator" >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:odorik-processor@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user" \
  --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:odorik-processor@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer" >/dev/null

echo "Bootstrap complete for $PROJECT_ID"
echo "REGION=$REGION"
echo "FIRESTORE_DATABASE_ID=$DATABASE_ID"
echo "RECORDINGS_BUCKET=$BUCKET"
echo "ARTIFACT_REPOSITORY=$REPOSITORY"
