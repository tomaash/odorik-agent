"""Repoint secret env vars on deployed Cloud Run services to `latest`.

Why this exists: firebase-tools resolves every `defineSecret` to a concrete
version number at deploy time (lib/deploy/functions/validate.js — it calls
getSecretVersion(..., "latest") and then assigns `s.version = sv.versionId`).
So a deployed function keeps reading the version that was current when it was
deployed, and rotating the secret has no effect until the next deploy.

Run this after `firebase deploy --only functions` to unpin the secrets that
should track `latest`.

  python3 infra/unpin-function-secrets.py --project P --region R GEMINI_API_KEY
  python3 infra/unpin-function-secrets.py --dry-run GEMINI_API_KEY

gcloud's `run services update --update-secrets` cannot be used here: it crashes
with "Invalid secret path ... in annotation" on the alias annotation that
Firebase writes, so this talks to the Cloud Run v2 API directly.
"""

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request


def access_token() -> str:
    result = subprocess.run(
        ["gcloud", "auth", "print-access-token"], capture_output=True, text=True
    )
    if result.returncode != 0:
        sys.exit("Could not obtain an access token; run `gcloud auth login`.")
    return result.stdout.strip()


def api(url: str, token: str, method: str = "GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        return json.load(urllib.request.urlopen(request))
    except urllib.error.HTTPError as exc:
        return {"_error": exc.read().decode()[:600]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("secrets", nargs="+", help="secret names that should track latest")
    parser.add_argument("--project", default="odorik-tx-260720-c58d")
    parser.add_argument("--region", default="europe-west3")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    token = access_token()
    base = (f"https://run.googleapis.com/v2/projects/{args.project}"
            f"/locations/{args.region}/services")

    listing = api(base, token)
    if "_error" in listing:
        sys.exit(f"Could not list services: {listing['_error']}")

    wanted = set(args.secrets)
    changed_any = False
    for service in listing.get("services", []):
        name = service["name"].rsplit("/", 1)[-1]
        template = service.get("template", {})
        # Output-only: Cloud Run must generate a fresh revision name.
        template.pop("revision", None)

        changed = False
        for container in template.get("containers", []):
            for env in container.get("env", []):
                ref = env.get("valueSource", {}).get("secretKeyRef")
                if not ref:
                    continue
                if ref.get("secret", "").rsplit("/", 1)[-1] not in wanted:
                    continue
                if ref.get("version") == "latest":
                    continue
                print(f"{name}: {env['name']} {ref.get('version')} -> latest")
                ref["version"] = "latest"
                changed = True

        if not changed:
            continue
        changed_any = True
        if args.dry_run:
            continue
        result = api(f"{base}/{name}?updateMask=template", token, "PATCH",
                     {"template": template})
        if "_error" in result:
            print(f"  PATCH failed: {result['_error']}")
        else:
            print("  patched")

    if not changed_any:
        print("Nothing to unpin; every matching secret already tracks latest.")
    elif args.dry_run:
        print("\nDry run only. Re-run without --dry-run to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
