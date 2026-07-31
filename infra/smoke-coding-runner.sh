#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

CODING_REGION="${CODING_REGION:-europe-west1}"
CODING_JOB="${CODING_JOB:-erik-coding-runner}"
CODING_BUCKET="${CODING_ARTIFACT_BUCKET:-${PROJECT_ID}-coding-artifacts-euw1}"
CODING_SIGNER_SERVICE_ACCOUNT_NAME="${CODING_SIGNER_SERVICE_ACCOUNT_NAME:-erik-coding-signer}"
CODING_SIGNER_SERVICE_ACCOUNT="${CODING_SIGNER_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUN_ID="cloud-smoke-$(date -u +%Y%m%d%H%M%S)"
OBJECT_ROOT="smoke/$RUN_ID"

SMOKE_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/erik-coding-smoke.XXXXXX")"
cleanup() {
  case "$SMOKE_TEMP" in
    "${TMPDIR:-/tmp}"/erik-coding-smoke.*) rm -rf -- "$SMOKE_TEMP" ;;
    *) echo "Refusing to remove unexpected temporary directory." >&2 ;;
  esac
}
trap cleanup EXIT

SMOKE_REPOSITORY="$SMOKE_TEMP/repository"
SOURCE_BUNDLE="$SMOKE_TEMP/source.bundle"
RUN_SPEC_PATH="$SMOKE_TEMP/run-spec.json"
ARTIFACT_PATH="$SMOKE_TEMP/artifacts.tar.gz"
EXTRACTED_PATH="$SMOKE_TEMP/artifacts"

git init --quiet --initial-branch=main "$SMOKE_REPOSITORY"
git -C "$SMOKE_REPOSITORY" config user.name "Agent Erik smoke test"
git -C "$SMOKE_REPOSITORY" config user.email "coding-smoke@agenterik.cz"
printf '%s\n' '# Agent Erik coding runner smoke repository' >"$SMOKE_REPOSITORY/README.md"
git -C "$SMOKE_REPOSITORY" add README.md
git -C "$SMOKE_REPOSITORY" commit --quiet -m "Smoke test base"
BASE_SHA="$(git -C "$SMOKE_REPOSITORY" rev-parse HEAD)"
git -C "$SMOKE_REPOSITORY" bundle create "$SOURCE_BUNDLE" HEAD
SOURCE_SHA256="$(openssl dgst -sha256 "$SOURCE_BUNDLE" | awk '{print $NF}')"

SOURCE_OBJECT="gs://$CODING_BUCKET/$OBJECT_ROOT/source.bundle"
SPEC_OBJECT="gs://$CODING_BUCKET/$OBJECT_ROOT/run-spec.json"
ARTIFACT_OBJECT="gs://$CODING_BUCKET/$OBJECT_ROOT/artifacts.tar.gz"
gcloud storage cp "$SOURCE_BUNDLE" "$SOURCE_OBJECT" --project="$PROJECT_ID" >/dev/null

SOURCE_URL="$(gcloud storage sign-url "$SOURCE_OBJECT" \
  --duration=2h \
  --region="$CODING_REGION" \
  --impersonate-service-account="$CODING_SIGNER_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format='value(signed_url)')"
ARTIFACT_URL="$(gcloud storage sign-url "$ARTIFACT_OBJECT" \
  --duration=2h \
  --region="$CODING_REGION" \
  --http-verb=PUT \
  --headers=content-type=application/gzip \
  --impersonate-service-account="$CODING_SIGNER_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format='value(signed_url)')"

RUN_ID="$RUN_ID" BASE_SHA="$BASE_SHA" SOURCE_SHA256="$SOURCE_SHA256" \
SOURCE_URL="$SOURCE_URL" ARTIFACT_URL="$ARTIFACT_URL" RUN_SPEC_PATH="$RUN_SPEC_PATH" \
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const spec = {
    schemaVersion: 1,
    runId: process.env.RUN_ID,
    source: {
      downloadUrl: process.env.SOURCE_URL,
      sha256: process.env.SOURCE_SHA256,
      baseSha: process.env.BASE_SHA,
    },
    task: {
      title: "Cloud Run subscription smoke test",
      prompt: "Create GROK_CLOUD_RUN_SMOKE.md containing exactly: Grok subscription smoke test passed. End the file with a newline, make no other changes, and verify the result with git diff.",
    },
    agent: { maxTurns: 10 },
    artifacts: { uploadUrl: process.env.ARTIFACT_URL },
    limits: {
      maxSourceBytes: 10485760,
      maxArtifactBytes: 10485760,
      maxChangedFiles: 5,
      maxPatchBytes: 1048576,
    },
  };
  writeFileSync(process.env.RUN_SPEC_PATH, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
'
gcloud storage cp "$RUN_SPEC_PATH" "$SPEC_OBJECT" \
  --content-type=application/json \
  --project="$PROJECT_ID" >/dev/null
RUN_SPEC_URL="$(gcloud storage sign-url "$SPEC_OBJECT" \
  --duration=2h \
  --region="$CODING_REGION" \
  --impersonate-service-account="$CODING_SIGNER_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format='value(signed_url)')"

echo "Executing coding smoke run $RUN_ID"
set +e
gcloud run jobs execute "$CODING_JOB" \
  --region="$CODING_REGION" \
  --update-env-vars="RUN_ID=$RUN_ID,RUN_SPEC_URL=$RUN_SPEC_URL" \
  --wait \
  --project="$PROJECT_ID"
EXECUTION_STATUS=$?
set -e

if ! gcloud storage cp "$ARTIFACT_OBJECT" "$ARTIFACT_PATH" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "The Job did not produce an artifact. Inspect its Cloud Run execution logs." >&2
  exit 1
fi
mkdir -p "$EXTRACTED_PATH"
tar -xzf "$ARTIFACT_PATH" -C "$EXTRACTED_PATH"
RUN_RESULT_PATH="$EXTRACTED_PATH/run-result.json" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const result = JSON.parse(readFileSync(process.env.RUN_RESULT_PATH, "utf8"));
  console.log(JSON.stringify({
    runId: result.runId,
    status: result.status,
    durationMs: result.durationMs,
    authKind: result.grok?.authKind,
    changedFiles: result.git?.changedFiles,
    hasChanges: result.git?.hasChanges,
    error: result.error?.message,
  }, null, 2));
  if (result.status !== "succeeded" || result.git?.changedFiles !== 1 || result.git?.hasChanges !== true) {
    process.exitCode = 1;
  }
'

if [[ "$EXECUTION_STATUS" -ne 0 ]]; then
  echo "Cloud Run reported a failed execution." >&2
  exit "$EXECUTION_STATUS"
fi

echo "Artifact: $ARTIFACT_OBJECT"
