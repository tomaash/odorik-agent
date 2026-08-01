# Agent Erik coding runner

This package is the isolated implementation worker for the GitHub + Grok coding-agent slice. One Cloud Run Job task consumes one immutable run specification, checks out a Git bundle on an ephemeral ext4 disk, runs Grok Build headlessly, and uploads a result archive.

## Authentication boundary

The runner uses a **Grok subscription OAuth session**, obtained with `grok login --device-auth`. It does not accept an xAI API key:

- `/etc/grok/requirements.toml` sets `disable_api_key_auth = true`;
- startup fails if `XAI_API_KEY` is present;
- the cached subscription session is mounted from Secret Manager and copied outside the repository workspace;
- Grok runs as UID `10001`, while repository preparation runs as UID `10002`;
- the runner has no GitHub write credential and does not push or create pull requests.

The cached session may eventually need reconnection. An authentication failure
becomes a visible subscription attention state; an administrator reconnects in
**Sources → Grok subscription**. `infra/configure-grok-subscription.sh` remains
only a break-glass operator path.

## Security boundary

The image pins Grok Build and a root-owned policy that disables bypass permissions, API-key auth, and auto-update. Grok runs with:

- the strict workspace sandbox;
- `dontAsk` permissions and a bounded local command allowlist;
- no web tools, memory, plan review, or subagents;
- explicit denies for GitHub writes, deployments, SSH, and container tools.

Before the agent starts, `grok inspect --json` must report no hooks, plugins, marketplaces, MCP servers, or repository-provided permission rules. Source and output use short-lived signed HTTPS URLs. Raw URLs are never logged.

The Job service account has access only to the Grok subscription secret. It has no Firestore, GitHub, or GCS bucket role; signed URLs carry the per-run input/output authority. Independent repository test execution is intentionally not implemented yet, because an unsandboxed child process could query the Cloud Run metadata server. Grok can run allowlisted tests inside its own strict sandbox.

The separate `erik-coding-signer` service account has object access to the coding artifact bucket and never runs repository code. The control plane may impersonate only this signer to mint short-lived per-run URLs. An operator can run `infra/smoke-coding-runner.sh` after receiving Token Creator on the signer service account.

The supervisor never resolves repository-controlled dependencies. Even with
lifecycle scripts disabled, a lockfile can cause network requests while Cloud
Run metadata is reachable. Existing/pre-provisioned dependencies may be used by
Grok inside the strict sandbox; otherwise dependency-requiring checks are
reported as unavailable. A later credential-free preparation Job may provide
reviewed dependency trees without widening the runner boundary.

## Input contract

The Cloud Run execution receives:

```text
RUN_ID=<same ID as the run spec>
RUN_SPEC_URL=<short-lived signed HTTPS GET URL>
CODING_CALLBACK_URL=<authenticated status callback audience and endpoint>
```

The URL returns JSON:

```json
{
  "schemaVersion": 1,
  "runId": "run_01JXYZ",
  "source": {
    "downloadUrl": "https://signed-source-bundle-url",
    "sha256": "64 lowercase hex characters",
    "baseSha": "Git commit SHA checked out by the bundle"
  },
  "task": {
    "title": "Implement issue #42",
    "prompt": "Normalized issue body and implementation constraints",
    "sourceUrl": "https://github.com/acme/widget/issues/42"
  },
  "agent": {
    "maxTurns": 30
  },
  "artifacts": {
    "uploadUrl": "https://signed-artifact-put-url",
    "patchUploadUrl": "https://signed-patch-put-url"
  },
  "limits": {
    "maxSourceBytes": 2147483648,
    "maxArtifactBytes": 52428800,
    "maxChangedFiles": 300,
    "maxPatchBytes": 10485760
  }
}
```

`agent.model` is optional. Omitting it uses the model selected by the Grok subscription rather than coupling Erik to an API model identifier.

The source is a Git bundle, not a tarball and not a live GitHub clone. This avoids placing a GitHub token or credential helper in the runner:

```bash
coding-runner/scripts/create-source-bundle.sh /path/to/repository main /tmp/source.bundle
```

The control plane must construct the bundle from the exact approved base commit, upload it privately, calculate SHA-256, and issue a short-lived signed GET URL.

## Output contract

The runner uploads an `application/gzip` archive and, when requested by the
run spec, a separately reviewable `text/x-diff` patch containing:

```text
run-result.json       machine-readable status and commit metadata
summary.md            short operator summary
changes.patch         binary-capable patch against baseSha
changed-files.txt     one path per line
result.bundle         result commit, omitted when there are no changes
grok-output.ndjson    bounded and basic-pattern-redacted headless output
```

Changed-file count, patch size, total artifact size, and likely-secret patterns are checked before upload. The result bundle has `baseSha` as a prerequisite and is applied by the trusted publisher under the implementation approval that existed before this runner started.

## Local verification

```bash
npm install
npm test
```

The test suite includes a complete local source-bundle → fake agent → patch/result-bundle → artifact archive smoke flow. A real subscription run is not part of automated tests because it would consume the shared Grok subscription allowance.

After deployment, an authorized operator can run the isolated real-subscription smoke fixture:

```bash
infra/smoke-coding-runner.sh
```

The script creates a temporary one-file Git repository, transfers it with short-lived signed URLs, waits for the Cloud Run execution, downloads the result artifact, and fails unless Grok produces exactly one changed file. It never passes a GitHub credential or xAI API key to the Job.

## GCP setup

From the repository root:

```bash
infra/bootstrap-coding-runner.sh
infra/bootstrap-coding-dispatcher.sh
infra/bootstrap-grok-auth-worker.sh
infra/deploy-grok-auth-worker.sh
infra/deploy-coding-runner.sh
infra/deploy-coding-dispatcher.sh
```

The authenticated Sources flow performs the normal device login. The separate
auth job uses 1 vCPU / 1 GiB and can rotate only the Grok subscription secret;
the coding runner can read that secret but cannot update it.

The deployment creates `erik-coding-runner` in `europe-west1` with 2 vCPU, 4 GiB RAM, a 10 GiB ephemeral ext4 volume, a 60-minute task timeout, and zero retries. Existing Firebase and Firestore resources remain in `europe-west3`.

Execute a prepared run with environment overrides:

```bash
gcloud run jobs execute erik-coding-runner \
  --region=europe-west1 \
  --update-env-vars=RUN_ID=run_01JXYZ,RUN_SPEC_URL=https://signed-run-spec-url \
  --wait
```

The trusted `erik-coding-dispatcher` uses
`roles/run.jobsExecutorWithOverrides` on this one Job. It refetches the
canonical issue and exact default-branch SHA, creates the Git bundle without
checking out repository content, and never receives the Grok secret. The
runner reports bounded phases and completion through a Google identity-token
callback; signed source/upload URLs never enter Firestore or Grok's process
environment. After a successful changed result, the same trusted image runs in
publish mode to push the deterministic result branch and open a draft PR; the
runner still receives no GitHub credential.

The first verified production smoke execution, `erik-coding-runner-k56fj`, completed on 2026-07-31. It authenticated with Grok subscription OAuth, changed exactly one file in the strict sandbox, produced a verified result bundle, and uploaded the immutable artifact. This validates the Cloud Run second-generation namespace support required by Grok's Linux sandbox as well as the disk-backed ephemeral volume path.
