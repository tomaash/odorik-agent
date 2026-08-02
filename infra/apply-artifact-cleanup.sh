#!/usr/bin/env bash
set -euo pipefail

# Artifact Registry bills storage above the 0.5 GB free tier. Every deploy pushes
# a fresh timestamped image and nothing removed the old ones, so the repositories
# grow without bound. These policies keep the last 5 versions per package plus
# anything tagged in the past 14 days, and drop the rest.
#
# Run with DRY_RUN=1 first: that records what the policy *would* delete without
# deleting anything, visible in the repository's cleanup policy dry-run output.

source "$(dirname "$0")/project.env"

DRY_RUN="${DRY_RUN:-1}"
POLICY_FILE="$(dirname "$0")/artifact-cleanup-policy.json"

dry_run_flag="--dry-run"
if [[ "$DRY_RUN" != "1" ]]; then
  dry_run_flag="--no-dry-run"
fi

apply_policy() {
  local repository="$1"
  local location="$2"
  gcloud artifacts repositories set-cleanup-policies "$repository" \
    --location="$location" \
    --policy="$POLICY_FILE" \
    "$dry_run_flag" \
    --project="$PROJECT_ID"
  echo "Applied cleanup policy to $repository ($location), dry-run=$DRY_RUN."
}

# gcf-artifacts is deliberately excluded. Firebase points every deployed
# function at the mutable `:version_1` tag and leaves the previous images
# untagged, but Cloud Run revisions pin the *digest* they were deployed with:
# revision api-00091 pins an untagged digest. Deleting untagged images there
# would destroy the rollback targets of live services. It is also only ~0.5 GB
# of the ~5.3 GB total. Use Firebase's own supported policy for that repository:
#
#   firebase functions:artifacts:setpolicy
#
apply_policy erik-coding europe-west1
apply_policy "$ARTIFACT_REPOSITORY" "$REGION"

echo
echo "Current sizes:"
gcloud artifacts repositories list --project="$PROJECT_ID" \
  --format="table(name.basename(),location,sizeBytes)"
if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "Dry run only. Re-run with DRY_RUN=0 to let the policies delete images."
fi
