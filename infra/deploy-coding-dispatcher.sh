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
CODING_RUNNER_JOB="${CODING_JOB:-erik-coding-runner}"
DISPATCHER_JOB="${CODING_DISPATCHER_JOB:-erik-coding-dispatcher}"
DISPATCHER_SERVICE_ACCOUNT_NAME="${CODING_DISPATCHER_SERVICE_ACCOUNT_NAME:-erik-coding-dispatcher}"
DISPATCHER_SERVICE_ACCOUNT="${DISPATCHER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CODING_SIGNER_SERVICE_ACCOUNT_NAME="${CODING_SIGNER_SERVICE_ACCOUNT_NAME:-erik-coding-signer}"
CODING_SIGNER_SERVICE_ACCOUNT="${CODING_SIGNER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CONTROL_PLANE_SERVICE_ACCOUNT="${CONTROL_PLANE_SERVICE_ACCOUNT:-odorik-crm@${PROJECT_ID}.iam.gserviceaccount.com}"
GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-Iv23liy3QUr30tDzuO2F}"

for value in "$PROJECT_ID" "$CODING_REGION" "$CODING_REPOSITORY" "$CODING_RUNNER_JOB" "$DISPATCHER_JOB"; do
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9.-]*$ ]]; then
    echo "Unsafe deployment identifier: $value" >&2
    exit 1
  fi
done

IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
DISPATCHER_IMAGE="$CODING_REGION-docker.pkg.dev/$PROJECT_ID/$CODING_REPOSITORY/dispatcher:$IMAGE_TAG"
gcloud builds submit coding-dispatcher --tag="$DISPATCHER_IMAGE" --project="$PROJECT_ID"

JOB_YAML="$(mktemp "${TMPDIR:-/tmp}/erik-coding-dispatcher.XXXXXX.yaml")"
cleanup() {
  case "$JOB_YAML" in
    "${TMPDIR:-/tmp}"/erik-coding-dispatcher.*.yaml) rm -f -- "$JOB_YAML" ;;
    *) echo "Refusing to remove unexpected temporary file." >&2 ;;
  esac
}
trap cleanup EXIT

sed \
  -e "s|__PROJECT_ID__|$PROJECT_ID|g" \
  -e "s|__CODING_REGION__|$CODING_REGION|g" \
  -e "s|__CODING_RUNNER_JOB__|$CODING_RUNNER_JOB|g" \
  -e "s|__CODING_BUCKET__|$CODING_BUCKET|g" \
  -e "s|__CODING_SIGNER_SERVICE_ACCOUNT__|$CODING_SIGNER_SERVICE_ACCOUNT|g" \
  -e "s|__GITHUB_CLIENT_ID__|$GITHUB_CLIENT_ID|g" \
  -e "s|__DISPATCHER_JOB__|$DISPATCHER_JOB|g" \
  -e "s|__DISPATCHER_SERVICE_ACCOUNT__|$DISPATCHER_SERVICE_ACCOUNT|g" \
  -e "s|__DISPATCHER_IMAGE__|$DISPATCHER_IMAGE|g" \
  infra/coding-dispatcher-job.yaml.tmpl >"$JOB_YAML"

gcloud run jobs replace "$JOB_YAML" --region="$CODING_REGION" --project="$PROJECT_ID"
gcloud run jobs add-iam-policy-binding "$DISPATCHER_JOB" \
  --member="serviceAccount:$CONTROL_PLANE_SERVICE_ACCOUNT" \
  --role=roles/run.jobsExecutorWithOverrides \
  --region="$CODING_REGION" \
  --project="$PROJECT_ID" >/dev/null

echo "Coding dispatcher deployed."
echo "JOB=$DISPATCHER_JOB"
echo "IMAGE=$DISPATCHER_IMAGE"
