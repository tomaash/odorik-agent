"""Print `secret<TAB>version` for every secret version a deployed Cloud Run
service or job currently mounts, so pruning never destroys a live credential.

Cloud Run rewrites secret references into per-service aliases: the container env
holds `secret-<hash>:<version>` and the revision annotation maps that alias back
to `projects/<project>/secrets/<name>`. Firebase-deployed functions pin an exact
version rather than `latest`, so the pinned version has to be resolved and kept.
"""

import json
import subprocess
import sys


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    return result.stdout


def resource_specs(project, region):
    for kind in ("services", "jobs"):
        out = run([
            "gcloud", "run", kind, "list",
            "--project", project, "--region", region, "--format", "json",
        ])
        if not out:
            continue
        try:
            items = json.loads(out)
        except json.JSONDecodeError:
            continue
        for item in items:
            yield kind, item


def template_of(kind, item):
    spec = item.get("spec", {})
    if kind == "services":
        return spec.get("template", {})
    return spec.get("template", {}).get("spec", {}).get("template", {})


def main():
    project = sys.argv[1]
    regions = sys.argv[2:] or ["europe-west3"]
    pinned = set()

    for region in regions:
        for kind, item in resource_specs(project, region):
            template = template_of(kind, item)
            annotations = template.get("metadata", {}).get("annotations", {})
            aliases = {}
            for entry in annotations.get("run.googleapis.com/secrets", "").split(","):
                if ":" not in entry:
                    continue
                alias, target = entry.split(":", 1)
                aliases[alias.strip()] = target.strip().rsplit("/", 1)[-1]

            containers = template.get("spec", {}).get("containers", [])
            for container in containers:
                for env in container.get("env", []):
                    ref = env.get("valueFrom", {}).get("secretKeyRef")
                    if not ref:
                        continue
                    name = ref.get("name", "")
                    version = str(ref.get("key", "")).strip()
                    secret = aliases.get(name, name).rsplit("/", 1)[-1]
                    if secret and version:
                        pinned.add((secret, version))
            for volume in template.get("spec", {}).get("volumes", []):
                secret_volume = volume.get("secret")
                if not secret_volume:
                    continue
                name = secret_volume.get("secretName", "")
                secret = aliases.get(name, name).rsplit("/", 1)[-1]
                for item_ref in secret_volume.get("items", []):
                    version = str(item_ref.get("key", "")).strip()
                    if secret and version:
                        pinned.add((secret, version))

    for secret, version in sorted(pinned):
        print(f"{secret}\t{version}")


if __name__ == "__main__":
    main()
