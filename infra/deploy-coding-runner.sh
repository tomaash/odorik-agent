#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

CODING_REGION="${CODING_REGION:-europe-west1}"
CODING_JOB="${CODING_JOB:-erik-coding-runner}"
CODING_REPOSITORY="${CODING_ARTIFACT_REPOSITORY:-erik-coding}"
CODING_SERVICE_ACCOUNT_NAME="${CODING_SERVICE_ACCOUNT_NAME:-erik-coding-runner}"
CODING_SERVICE_ACCOUNT="${CODING_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CONTROL_PLANE_SERVICE_ACCOUNT="${CONTROL_PLANE_SERVICE_ACCOUNT:-odorik-crm@${PROJECT_ID}.iam.gserviceaccount.com}"

for value in "$PROJECT_ID" "$CODING_REGION" "$CODING_JOB" "$CODING_REPOSITORY" "$CODING_SERVICE_ACCOUNT_NAME"; do
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9.-]*$ ]]; then
    echo "Unsafe deployment identifier: $value" >&2
    exit 1
  fi
done
if [[ "$CODING_REGION" != "europe-west1" ]]; then
  echo "CODING_REGION must be europe-west1 while Cloud Run ephemeral disk is in Preview." >&2
  exit 1
fi

ENABLED_AUTH_VERSION="$(gcloud secrets versions list grok-subscription-auth \
  --filter='state=ENABLED' --limit=1 --format='value(name)' --project="$PROJECT_ID")"
if [[ -z "$ENABLED_AUTH_VERSION" ]]; then
  echo "No Grok subscription auth version exists. Run infra/configure-grok-subscription.sh first." >&2
  exit 1
fi

IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
CODING_IMAGE="$CODING_REGION-docker.pkg.dev/$PROJECT_ID/$CODING_REPOSITORY/runner:$IMAGE_TAG"
gcloud builds submit coding-runner --tag="$CODING_IMAGE" --project="$PROJECT_ID"

JOB_YAML="$(mktemp "${TMPDIR:-/tmp}/erik-coding-job.XXXXXX.yaml")"
cleanup() {
  case "$JOB_YAML" in
    "${TMPDIR:-/tmp}"/erik-coding-job.*.yaml) rm -f -- "$JOB_YAML" ;;
    *) echo "Refusing to remove unexpected temporary file." >&2 ;;
  esac
}
trap cleanup EXIT

sed \
  -e "s|__CODING_JOB__|$CODING_JOB|g" \
  -e "s|__CODING_REGION__|$CODING_REGION|g" \
  -e "s|__CODING_SERVICE_ACCOUNT__|$CODING_SERVICE_ACCOUNT|g" \
  -e "s|__CODING_IMAGE__|$CODING_IMAGE|g" \
  infra/coding-runner-job.yaml.tmpl >"$JOB_YAML"

gcloud run jobs replace "$JOB_YAML" \
  --region="$CODING_REGION" \
  --project="$PROJECT_ID"

if gcloud iam service-accounts describe "$CONTROL_PLANE_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud run jobs add-iam-policy-binding "$CODING_JOB" \
    --member="serviceAccount:$CONTROL_PLANE_SERVICE_ACCOUNT" \
    --role=roles/run.jobsExecutorWithOverrides \
    --region="$CODING_REGION" \
    --project="$PROJECT_ID" >/dev/null
else
  echo "Control-plane service account not found; skipping Job executor binding." >&2
fi

echo "Coding runner deployed."
echo "JOB=$CODING_JOB"
echo "REGION=$CODING_REGION"
echo "IMAGE=$CODING_IMAGE"
echo "AUTH_KIND=Grok subscription OAuth (not an xAI API key)"
