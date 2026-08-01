#!/usr/bin/env bash
set -euo pipefail

if [[ -f infra/project.env ]]; then
  # shellcheck disable=SC1091
  source infra/project.env
fi

: "${PROJECT_ID:?Set PROJECT_ID or create infra/project.env}"

GITHUB_APP_PRIVATE_KEY_SECRET="${GITHUB_APP_PRIVATE_KEY_SECRET:-GITHUB_APP_PRIVATE_KEY}"
CONTROL_PLANE_SERVICE_ACCOUNT="${CONTROL_PLANE_SERVICE_ACCOUNT:-odorik-crm@${PROJECT_ID}.iam.gserviceaccount.com}"
PEM_PATH="${1:-}"

if [[ -z "$PEM_PATH" ]]; then
  pem_files=()
  while IFS= read -r pem_file; do
    pem_files+=("$pem_file")
  done < <(find infra -maxdepth 1 -type f -name '*.pem' -print)
  if [[ "${#pem_files[@]}" -ne 1 ]]; then
    echo "Pass the GitHub App PEM path; automatic discovery requires exactly one infra/*.pem file." >&2
    exit 1
  fi
  PEM_PATH="${pem_files[0]}"
fi

case "$PEM_PATH" in
  infra/*.pem) ;;
  *) echo "The GitHub App private key must be an infra/*.pem file." >&2; exit 1 ;;
esac
if [[ ! -f "$PEM_PATH" ]] || ! git check-ignore -q -- "$PEM_PATH"; then
  echo "The PEM must exist and be ignored by Git." >&2
  exit 1
fi
if git ls-files --error-unmatch "$PEM_PATH" >/dev/null 2>&1; then
  echo "Refusing to upload a tracked private key." >&2
  exit 1
fi
openssl pkey -in "$PEM_PATH" -check -noout >/dev/null
chmod 0600 "$PEM_PATH"

if gcloud secrets describe "$GITHUB_APP_PRIVATE_KEY_SECRET" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets versions add "$GITHUB_APP_PRIVATE_KEY_SECRET" \
    --data-file="$PEM_PATH" \
    --project="$PROJECT_ID" >/dev/null
else
  gcloud secrets create "$GITHUB_APP_PRIVATE_KEY_SECRET" \
    --replication-policy=automatic \
    --labels=provider=github,credential=app-private-key \
    --data-file="$PEM_PATH" \
    --project="$PROJECT_ID" >/dev/null
fi

gcloud secrets add-iam-policy-binding "$GITHUB_APP_PRIVATE_KEY_SECRET" \
  --member="serviceAccount:$CONTROL_PLANE_SERVICE_ACCOUNT" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null

echo "GitHub App private key stored in Secret Manager."
echo "SECRET=$GITHUB_APP_PRIVATE_KEY_SECRET"
echo "CONSUMER=$CONTROL_PLANE_SERVICE_ACCOUNT"
echo "Required GitHub App repository permissions: Contents=Read and write, Issues=Read-only, Pull requests=Read and write, Metadata=Read-only."
echo "Observer tokens are downscoped to read-only; publisher tokens are restricted to one approved repository."
