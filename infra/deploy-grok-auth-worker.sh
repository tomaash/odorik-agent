#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

GROK_AUTH_REGION="${GROK_AUTH_REGION:-europe-west1}"
GROK_AUTH_JOB="${GROK_AUTH_JOB:-erik-grok-auth}"
GROK_AUTH_REPOSITORY="${CODING_ARTIFACT_REPOSITORY:-erik-coding}"
GROK_AUTH_SERVICE_ACCOUNT_NAME="${GROK_AUTH_SERVICE_ACCOUNT_NAME:-erik-grok-auth}"
GROK_AUTH_SERVICE_ACCOUNT="${GROK_AUTH_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CONTROL_PLANE_SERVICE_ACCOUNT="${CONTROL_PLANE_SERVICE_ACCOUNT:-odorik-crm@${PROJECT_ID}.iam.gserviceaccount.com}"

for value in "$PROJECT_ID" "$GROK_AUTH_REGION" "$GROK_AUTH_JOB" "$GROK_AUTH_REPOSITORY" "$GROK_AUTH_SERVICE_ACCOUNT_NAME"; do
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9.-]*$ ]]; then
    echo "Unsafe deployment identifier: $value" >&2
    exit 1
  fi
done

if ! gcloud iam service-accounts describe "$GROK_AUTH_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Grok auth service account is missing. Run infra/bootstrap-grok-auth-worker.sh first." >&2
  exit 1
fi

IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
GROK_AUTH_IMAGE="$GROK_AUTH_REGION-docker.pkg.dev/$PROJECT_ID/$GROK_AUTH_REPOSITORY/grok-auth:$IMAGE_TAG"
gcloud builds submit grok-auth-worker --tag="$GROK_AUTH_IMAGE" --project="$PROJECT_ID"

JOB_YAML="$(mktemp "${TMPDIR:-/tmp}/erik-grok-auth-job.XXXXXX.yaml")"
cleanup() {
  case "$JOB_YAML" in
    "${TMPDIR:-/tmp}"/erik-grok-auth-job.*.yaml) rm -f -- "$JOB_YAML" ;;
    *) echo "Refusing to remove unexpected temporary file." >&2 ;;
  esac
}
trap cleanup EXIT

sed \
  -e "s|__PROJECT_ID__|$PROJECT_ID|g" \
  -e "s|__GROK_AUTH_JOB__|$GROK_AUTH_JOB|g" \
  -e "s|__GROK_AUTH_REGION__|$GROK_AUTH_REGION|g" \
  -e "s|__GROK_AUTH_SERVICE_ACCOUNT__|$GROK_AUTH_SERVICE_ACCOUNT|g" \
  -e "s|__GROK_AUTH_IMAGE__|$GROK_AUTH_IMAGE|g" \
  infra/grok-auth-worker-job.yaml.tmpl >"$JOB_YAML"

gcloud run jobs replace "$JOB_YAML" \
  --region="$GROK_AUTH_REGION" \
  --project="$PROJECT_ID"

gcloud run jobs add-iam-policy-binding "$GROK_AUTH_JOB" \
  --member="serviceAccount:$CONTROL_PLANE_SERVICE_ACCOUNT" \
  --role=roles/run.jobsExecutorWithOverrides \
  --region="$GROK_AUTH_REGION" \
  --project="$PROJECT_ID" >/dev/null

echo "Grok auth worker deployed."
echo "JOB=$GROK_AUTH_JOB"
echo "REGION=$GROK_AUTH_REGION"
echo "IMAGE=$GROK_AUTH_IMAGE"
echo "AUTH_KIND=Grok subscription OAuth (xAI API keys are forbidden)"
