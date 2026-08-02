#!/usr/bin/env bash
set -euo pipefail

source infra/project.env

: "${DASHBOARD_TOKEN:?Set DASHBOARD_TOKEN}"
: "${ODORIK_UPLOAD_USER:?Set ODORIK_UPLOAD_USER}"
: "${ODORIK_UPLOAD_PASSWORD:?Set ODORIK_UPLOAD_PASSWORD}"
: "${GEMINI_API_KEY:?Set GEMINI_API_KEY}"
: "${DEEPGRAM_API_KEY:?Set DEEPGRAM_API_KEY}"

IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$ARTIFACT_REPOSITORY/app:$(date -u +%Y%m%d%H%M%S)"

# Every active secret version is billed monthly, so only add a version when the
# value actually changed, and destroy the superseded ones. Disabling is not
# enough: disabled versions stay billable until they are destroyed.
upsert_secret() {
  local name="$1"
  local value="$2"
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic --project="$PROJECT_ID"
  else
    local current
    current="$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT_ID" 2>/dev/null || true)"
    if [[ "$current" == "$value" ]]; then
      echo "$name unchanged; keeping the current version."
      return 0
    fi
  fi
  local new_version
  new_version="$(printf '%s' "$value" | gcloud secrets versions add "$name" \
    --data-file=- --format='value(name)' --project="$PROJECT_ID")"
  destroy_superseded_versions "$name" "$new_version"
}

destroy_superseded_versions() {
  local name="$1"
  local keep="$2"
  local version
  while IFS= read -r version; do
    [[ -n "$version" && "$version" != "$keep" ]] || continue
    gcloud secrets versions destroy "$version" \
      --secret="$name" \
      --quiet \
      --project="$PROJECT_ID" >/dev/null
    echo "Destroyed superseded $name version $version."
  done < <(gcloud secrets versions list "$name" \
    --filter='state!=DESTROYED' \
    --format='value(name)' \
    --project="$PROJECT_ID")
}

upsert_secret dashboard-token "$DASHBOARD_TOKEN"
upsert_secret odorik-upload-user "$ODORIK_UPLOAD_USER"
upsert_secret odorik-upload-password "$ODORIK_UPLOAD_PASSWORD"
upsert_secret gemini-api-key "$GEMINI_API_KEY"
upsert_secret DEEPGRAM_API_KEY "$DEEPGRAM_API_KEY"
if [[ -n "${CONNECTOR_CREDENTIAL_KEY:-}" ]]; then
  upsert_secret CONNECTOR_CREDENTIAL_KEY "$CONNECTOR_CREDENTIAL_KEY"
fi

gcloud secrets add-iam-policy-binding dashboard-token \
  --member="serviceAccount:odorik-api@$PROJECT_ID.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null
for secret in odorik-upload-user odorik-upload-password; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:odorik-ingest@$PROJECT_ID.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor \
    --project="$PROJECT_ID" >/dev/null
done
if gcloud secrets describe CONNECTOR_CREDENTIAL_KEY --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets add-iam-policy-binding CONNECTOR_CREDENTIAL_KEY \
    --member="serviceAccount:odorik-ingest@$PROJECT_ID.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor \
    --project="$PROJECT_ID" >/dev/null
fi
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:odorik-processor@$PROJECT_ID.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null
gcloud secrets add-iam-policy-binding DEEPGRAM_API_KEY \
  --member="serviceAccount:odorik-processor@$PROJECT_ID.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null

gcloud builds submit --tag="$IMAGE" --project="$PROJECT_ID"

COMMON_ENV="PROJECT_ID=$PROJECT_ID,FIRESTORE_DATABASE_ID=$FIRESTORE_DATABASE_ID,GEMINI_MODEL=gemini-3.5-flash-lite"

gcloud run deploy odorik-api \
  --image="$IMAGE" \
  --command=node \
  --args=dist/api.js \
  --region="$REGION" \
  --service-account="odorik-api@$PROJECT_ID.iam.gserviceaccount.com" \
  --set-env-vars="$COMMON_ENV" \
  --set-secrets="DASHBOARD_TOKEN=dashboard-token:latest" \
  --allow-unauthenticated \
  --min=0 \
  --max=3 \
  --memory=512Mi \
  --project="$PROJECT_ID"

gcloud run deploy odorik-ingest \
  --image="$IMAGE" \
  --command=node \
  --args=dist/ingest.js \
  --region="$REGION" \
  --service-account="odorik-ingest@$PROJECT_ID.iam.gserviceaccount.com" \
  --set-env-vars="$COMMON_ENV,RECORDINGS_BUCKET=$RECORDINGS_BUCKET" \
  --set-secrets="ODORIK_UPLOAD_USER=odorik-upload-user:latest,ODORIK_UPLOAD_PASSWORD=odorik-upload-password:latest,CONNECTOR_CREDENTIAL_KEY=CONNECTOR_CREDENTIAL_KEY:latest" \
  --allow-unauthenticated \
  --min=0 \
  --max=3 \
  --memory=512Mi \
  --timeout=120 \
  --project="$PROJECT_ID"

gcloud run deploy odorik-processor \
  --image="$IMAGE" \
  --command=node \
  --args=dist/processor.js \
  --region="$REGION" \
  --service-account="odorik-processor@$PROJECT_ID.iam.gserviceaccount.com" \
  --set-env-vars="$COMMON_ENV" \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest,DEEPGRAM_API_KEY=DEEPGRAM_API_KEY:latest" \
  --no-allow-unauthenticated \
  --min=0 \
  --max=3 \
  --memory=1Gi \
  --timeout=300 \
  --project="$PROJECT_ID"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
EVENTARC_SA="odorik-eventarc@$PROJECT_ID.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$EVENTARC_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create odorik-eventarc \
    --display-name="Odorik Eventarc invoker" \
    --project="$PROJECT_ID"
fi
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$EVENTARC_SA" \
  --role=roles/eventarc.eventReceiver \
  --condition=None >/dev/null
gcloud run services add-iam-policy-binding odorik-processor \
  --region="$REGION" \
  --member="serviceAccount:$EVENTARC_SA" \
  --role=roles/run.invoker \
  --project="$PROJECT_ID" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountTokenCreator \
  --condition=None >/dev/null
STORAGE_SA="$(gcloud storage service-agent --project="$PROJECT_ID")"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$STORAGE_SA" \
  --role=roles/pubsub.publisher \
  --condition=None >/dev/null

if ! gcloud eventarc triggers describe recording-finalized --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud eventarc triggers create recording-finalized \
    --location="$REGION" \
    --destination-run-service=odorik-processor \
    --destination-run-region="$REGION" \
    --destination-run-path=/events/storage \
    --event-filters="type=google.cloud.storage.object.v1.finalized" \
    --event-filters="bucket=$RECORDINGS_BUCKET" \
    --service-account="$EVENTARC_SA" \
    --project="$PROJECT_ID"
fi

API_URL="$(gcloud run services describe odorik-api --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
INGEST_URL="$(gcloud run services describe odorik-ingest --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"

echo "API_URL=$API_URL"
echo "INGEST_URL=$INGEST_URL"
echo "IMAGE=$IMAGE"
