#!/usr/bin/env bash
set -euo pipefail

# Secret Manager bills every secret version that is not DESTROYED — enabled and
# disabled alike. Deploy and rotation scripts used to add a version per run and
# never destroyed the superseded ones, so old values accumulate as pure cost.
#
# This destroys superseded versions, keeping:
#   * the newest enabled version of each secret, and
#   * any version a deployed Cloud Run service or job is pinned to. Firebase
#     deploys pin an exact version rather than `latest`, so destroying the
#     newest-but-one would take a running function down.
#
# Destroying is irreversible: the payload is gone, not just hidden. DRY_RUN=1
# (the default) prints the plan without touching anything.
#
#   infra/prune-secret-versions.sh                        # show the plan
#   DRY_RUN=0 infra/prune-secret-versions.sh              # destroy
#   DRY_RUN=0 PROJECT_ID=other-project REGIONS="europe-west1" infra/prune-secret-versions.sh

here="$(dirname "$0")"
if [[ -z "${PROJECT_ID:-}" ]]; then
  source "$here/project.env"
fi

DRY_RUN="${DRY_RUN:-1}"
REGIONS="${REGIONS:-europe-west3 europe-west1}"
destroyed=0
kept=0

echo "Collecting secret versions in use by deployed Cloud Run resources..."
# shellcheck disable=SC2086
IN_USE="$(python3 "$here/collect-inuse-secret-versions.py" "$PROJECT_ID" $REGIONS)"
echo "$IN_USE" | sed 's/^/  in use: /'
echo

in_use() {
  printf '%s\n' "$IN_USE" | grep -qx "$1	$2"
}

while IFS= read -r secret; do
  [[ -n "$secret" ]] || continue
  keep="$(gcloud secrets versions list "$secret" \
    --filter='state=ENABLED' \
    --sort-by=~createTime \
    --limit=1 \
    --format='value(name)' \
    --project="$PROJECT_ID")"
  if [[ -z "$keep" ]]; then
    echo "!! $secret has no enabled version; skipping so nothing is lost."
    continue
  fi
  echo "$secret: keeping version $keep"
  kept=$((kept + 1))
  while IFS= read -r version; do
    [[ -n "$version" && "$version" != "$keep" ]] || continue
    if in_use "$secret" "$version"; then
      echo "   keeping version $version (pinned by a deployed service)"
      continue
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "   would destroy version $version"
    else
      gcloud secrets versions destroy "$version" \
        --secret="$secret" \
        --quiet \
        --project="$PROJECT_ID" >/dev/null
      echo "   destroyed version $version"
    fi
    destroyed=$((destroyed + 1))
  done < <(gcloud secrets versions list "$secret" \
    --filter='state!=DESTROYED' \
    --format='value(name)' \
    --project="$PROJECT_ID")
done < <(gcloud secrets list --format='value(name.basename())' --project="$PROJECT_ID")

echo
if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: $destroyed version(s) would be destroyed across $kept secret(s)."
  echo "Re-run with DRY_RUN=0 to apply."
else
  echo "Destroyed $destroyed version(s) across $kept secret(s)."
fi
echo "Secret Manager bills roughly \$0.06 per active version per month."
