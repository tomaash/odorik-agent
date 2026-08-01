# Proposal: GitHub + Grok coding agent for Agent Erik

**Status:** implementation started (CG0 runner foundation + CG1 read foundation + CG2 subscription connection)
**Date:** 2026-08-01
**Working name:** Coding Agent slice (provider phase `R1` / coding-agent epic)
**Depends on:** connector kernel (C0–C3), typed action registry (C2), approval execution path (G3-class external writes)

## 1. Summary

Extend Agent Erik so a company can:

1. **Subscribe a GitHub account** (GitHub App or OAuth) and **explicitly select repositories**.
2. **Connect a Grok subscription** as the coding-agent runtime using refreshable OAuth/device login — **not an xAI API key**.
3. **Automatically claim eligible GitHub issues** under a published policy.
4. **Implement the issue on Cloud Run** inside an isolated workspace using the Grok agent (ACP).
5. **Open a pull request** back to GitHub with a full responsibility trail in Erik.

This is not a free-running autonomous engineer. It is a **governed coding loop** that reuses Erik’s existing invariants:

```text
agents may observe and propose
people decide (or an explicitly approved policy decides)
application capabilities execute
the audit trail explains all three
```

### Implemented foundation

The repository now contains the first CG0/Cloud Run foundation:

- `coding-runner/`: pinned Grok Build headless runner, subscription-only authentication policy, Git-bundle input, patch/result-bundle output, limits, redaction, and tests;
- `infra/coding-runner-job.yaml.tmpl`: 2 vCPU / 4 GiB Cloud Run Job with a 10 GiB ephemeral ext4 disk in `europe-west1`;
- `infra/bootstrap-coding-runner.sh`, `configure-grok-subscription.sh`, and `deploy-coding-runner.sh`: least-privilege GCP bootstrap, device-OAuth secret setup, and deployment.
- `grok-auth-worker/`: a separate 1 vCPU / 1 GiB device-OAuth job that rotates
  only the Grok subscription secret, plus an authenticated Sources connection
  flow that never exposes `auth.json` to the browser.

The authenticated coding-run dispatcher, coding-run persistence/UI, and
approval-gated PR publisher remain subsequent slices. The runner intentionally
cannot push or create a PR.

The product already foreshadows GitHub as a source adapter in Sources copy (“Issues and comments from explicitly selected repositories”). This proposal makes that real and adds the write/execution half.

## 2. Problem

Teams already run Grok locally (CLI / grok-remote ACP) and track work in GitHub Issues. That combination does not give:

- company tenancy and membership;
- connector-style credential isolation;
- explicit repo selection and least privilege;
- durable issue → run → PR linkage;
- approval, policy, and audit for side effects;
- a cloud runner that does not depend on a developer laptop.

Erik already has: multi-tenant connections, encrypted credentials, ContextItems, agent threads, typed actions, named approvers, Cloud Run services, and a factual Gemini agent. Missing pieces are **GitHub**, **Grok as a coding runtime**, and a **long-running sandboxed job** that can clone, edit, test, and open PRs.

## 3. Goals

| Goal | Success signal |
| --- | --- |
| GitHub source subscription | Admin connects GitHub, selects repos; issues/comments appear as searchable `ContextItem`s with deep links |
| Grok subscription | Company connects a dedicated Grok subscription session; coding runs consume its shared subscription allowance without an xAI API key |
| Auto-claim issues | Eligible open issues become Erik tasks / coding runs without manual copy-paste |
| Cloud Run implementation | A job clones the repo, runs Grok agent work, persists artifacts, does not require a laptop |
| Open PR | An approved (or policy-delegated) action creates a draft/ready PR and stores provider result IDs |
| Governance | No GitHub write occurs outside typed actions + recorded decision or published automation policy |
| Audit | From PR or issue, an operator can reconstruct who authorized what and which evidence was used |

## 4. Non-goals (v1)

- Replacing GitHub Projects, Actions, or code review UI.
- Multi-provider coding agents (Claude Code, Codex, Cursor) — Grok only first.
- Automatic merge to `main` / production deploys.
- Silent expansion of scopes when adding write capabilities.
- Arbitrary model-generated workflow code deployed into Erik.
- Full org-wide repo auto-selection.
- Using Grok as the factual company Q&A model (Gemini path stays as-is unless a later model-router slice).
- Running untrusted customer code outside the job sandbox network/filesystem policy.

## 5. Product loop

```text
GitHub issue observed (selected repo)
        ↓
eligibility policy evaluates labels / assignees / keywords / milestone
        ↓
Erik creates a CodingTask (or claims issue + internal task)
        ↓
proposal: "Implement issue #N in repo R on branch B → open draft PR"
        ↓
decision:
  • human Approve on the card, OR
  • pre-approved AutomationPolicy for that repo/label class
        ↓
Cloud Run coding job starts (workspace + Grok ACP agent)
        ↓
agent implements, runs tests, commits on a branch
        ↓
typed action github.pr.create executes (idempotent)
        ↓
PR URL + head SHA + check status stored; issue linked; queue updated
```

Human responsibility remains the default. **Automation is an explicit, versioned policy object**, not an implied property of “having an agent.”

## 6. Fit with existing architecture

| Erik concept | Coding-agent use |
| --- | --- |
| Adapter | `github`, `grok_subscription` |
| Connection | One GitHub install/account; one refreshable Grok subscription login |
| Resource | Selected GitHub repository (and optionally projects/labels filters) |
| ContextItem | `github.issue`, `github.issue_comment`, later `github.pr` |
| Thread / agent run | Coding session stream (tool calls, thoughts, commands) as derived state |
| Proposal + Decision | Claim, implement, open-PR, comment — external effects |
| Action registry | `github.issue.claim`, `github.issue.comment`, `github.pr.create`, `github.pr.request_review` |
| ActionExecution | Provider-aware idempotency + `outcome_unknown` reconciliation |
| Cloud Run | Existing pattern for API/ingest/processor; **new Jobs service** for long coding runs |
| Approval UI | Reuse decision cards; add coding-run detail (diff stats, PR link, logs) |

This is a natural **R1 specialist system-of-record** candidate in `CONNECTOR_EPIC.md`, plus a new **coding runtime** plane that Gmail/Calendar do not need.

## 7. Subscriptions

### 7.1 GitHub subscription

**Recommended auth:** GitHub App (company install) rather than a personal PAT.

Reasons:

- install is per-org and reviewable;
- fine-grained repository selection maps to Erik resources;
- webhooks for issues/PRs without polling-only design;
- permissions are capability-shaped (`Issues`, `Pull requests`, `Contents`, `Metadata`).

**OAuth user-to-server** is acceptable for a spike (single-user), but production should use an App so credentials are not tied to one employee’s personal token.

**Capabilities (split read/write):**

```text
context.github.issue.read          observe selected repos' issues + comments
context.github.pr.read             observe PRs (optional v1.1)
action.github.issue.claim          assign / label "in progress" / comment claim
action.github.issue.comment        post a structured progress/result comment
action.github.pr.create            open PR from branch
action.github.pr.request_review    optional later
```

**Resource selection:** after install, admin explicitly enables repositories. Nothing is selected by default (same invariant as Calendar/Drive).

**Webhook endpoint:**

```text
POST /webhooks/github
```

Verify the signature with the App webhook secret from Secret Manager. Resolve
the tenant exclusively through a server-owned installation-to-connection map,
deduplicate `X-GitHub-Delivery`, persist a minimized queue record, and return
quickly. A retryable worker revalidates the route and fetches the canonical
issue/comments with a short-lived installation token before updating
ContextItems. A periodic full read sync reconciles missed deliveries.

### 7.2 Grok subscription

**Auth:** a dedicated Grok subscription account signs in with `grok login --device-auth`. Grok Build stores a refreshable OAuth session in `auth.json`; Erik treats that file as opaque secret material in Google Secret Manager. This design deliberately rejects `XAI_API_KEY` and direct xAI API billing. The official Grok Build consent currently includes broad Grok.com and Grok Projects read/write scopes. Erik cannot narrow scopes controlled by xAI's OAuth client, so the connected subscription should not be a personal account containing unrelated chats or projects.

**Product surface:** Sources or a new **Coding provider** section under company settings:

- provider: `grok_subscription`
- account label and optional Grok team/workspace identifier
- status: `active | attention_required | disconnected`
- last successful coding run, last authentication, and last error
- run duration/model/turns; subscription allowance remains managed in Grok settings

**What “Grok subscription” means in Erik:**

| Layer | Role |
| --- | --- |
| Subscription connection | Proves a dedicated account may use Grok Build |
| Coding runtime config | Max wall time, max turns, allowed commands, and repository limits |
| Job secret mount | Read-only cached OAuth session copied outside the repository workspace |

The subscription session is never placed in frontend configuration, Firestore, or the Git workspace. For the MVP, an expired/rotated session marks the connection `attention_required`; an administrator repeats device login from Sources and the auth-only worker stores a new Secret Manager version. The coding Job does not receive permission to mutate Secret Manager. Disconnect disables all enabled versions so new runner mounts fail; it does not revoke the OAuth grant at xAI.

**Runtime:** pin `@xai-official/grok` in the runner image and use headless `grok --prompt-file ... --output-format streaming-json`. Run with `dontAsk`, explicit allow/deny rules, the strict workspace sandbox, no subagents/memory/web tools, and a root-owned `/etc/grok/requirements.toml` that disables API-key auth and bypass-permissions mode.

## 8. Automated issue taking

### 8.1 Eligibility policy (versioned)

```ts
type CodingAutomationPolicy = {
  id: string
  companyId: string
  version: number
  status: "draft" | "active" | "disabled"
  githubConnectionId: string
  repoResourceIds: string[]          // empty = none; never "all by default"
  issueFilter: {
    labelsAny?: string[]             // e.g. ["erik-implement"]
    labelsNone?: string[]            // e.g. ["do-not-autogen"]
    assignees?: "unassigned" | "bot" | "any"
    authors?: string[]
    titleRegex?: string
  }
  claim: {
    mode: "label_and_comment" | "assign_bot" | "project_status"
    claimLabel?: string              // e.g. "erik-claimed"
    commentTemplateId: string
  }
  implementation: {
    baseBranch: string               // default "main"
    branchPrefix: string             // "erik/"
    draftPr: boolean                 // default true for v1
    maxRuntimeMinutes: number
    maxAttempts: number
    requiredChecks?: string[]        // wait / report only
  }
  approval: {
    // Human gate vs delegated automation
    claimRequiresApproval: boolean
    openPrRequiresApproval: boolean  // default true for first production week
    approverUids?: string[]          // named approvers; empty = repo code owners mapping later
  }
  publishedBy: string
  publishedAt: string
  digest: string                     // immutable published content hash
}
```

Publishing a policy is itself a consequential company action: either admin-only with audit, or a `policy.publish` approval card. Prefer admin + audit for v1; elevate to proposal if multi-admin companies need it.

### 8.2 Claim flow

1. Webhook / reconcile sees issue matching active policy.
2. Worker creates `CodingRun` in `queued` and optionally an Erik `task` for visibility.
3. If `claimRequiresApproval`: proposal card; else execute `github.issue.claim` under policy digest.
4. Claim action is idempotent on `(connectionId, repo, issueNumber)` — redelivery must not double-assign spam.
5. Issue ContextItem updates; agent thread links to the run.

**Default recommended v1 policy:**

- only issues with label `erik-implement`;
- draft PR only;
- **open PR requires human approval** after the agent finishes;
- claim may be automatic (label + bot comment) to avoid queue lag.

This satisfies “automated taking” without unsupervised external writes of code.

## 9. Cloud Run implementation plane

### 9.1 Why Cloud Run Jobs (not only Functions)

Coding sessions need:

- multi-minute to multi-hour wall time;
- large container (git, node/python toolchains, grok CLI);
- writable workspace disk;
- concurrency limits per company;
- clear start/stop billing.

**Recommendation:**

| Component | Runtime |
| --- | --- |
| Control plane API (tRPC, webhooks, approvals) | Existing Firebase Functions / Cloud Run API |
| Issue eligibility + claim worker | Short Cloud Function / Cloud Run request |
| **Coding job** | **Cloud Run Job** (or Job-executed from a private Cloud Run service) |
| Artifact storage | GCS bucket `coding-workspaces` (ephemeral) + optional log export |
| Secrets | Secret Manager; GitHub App private key stays in the control plane; runner mounts only the Grok subscription OAuth session |

### 9.2 Job lifecycle

```text
queued → provisioning → cloning → agent_running → verifying →
  awaiting_pr_approval → opening_pr → succeeded
                       ↘ failed_safe_to_retry
                       ↘ failed_terminal
                       ↘ cancelled
                       ↘ outcome_unknown  (PR API ambiguity)
```

Workspace layout (ephemeral):

```text
/workspace/
  repo/                 # git clone (shallow + fetch depth as needed)
  uploads/              # issue body, attachments metadata
  artifacts/            # test logs, agent transcript export
  meta.json             # runId, issue, policy digest, base SHA
```

**Deployed MVP shape:** the coding Job runs in `europe-west1` because Cloud Run ephemeral disk is currently available there. It uses 2 vCPU, 4 GiB RAM, a 10 GiB encrypted ext4 volume mounted at `/workspace`, a 60-minute task timeout, and zero automatic retries. Existing Firebase/Firestore services remain in `europe-west3`.

### 9.3 Isolation and safety

- One job execution = one `CodingRun` = one workspace.
- Network egress allowlist where possible: GitHub, xAI, package registries required by the repo.
- No mount of company Firestore credentials into the agent beyond a **short-lived job token** that can only append run events and complete the run (not read other companies).
- Source arrives as a clean Git bundle through a short-lived signed URL; the runner receives no GitHub credential.
- `git config` user = bot identity (`erik-bot[bot]` or company bot user).
- Resource caps: vCPU/memory, max runtime, max commits, max PR size (files/lines) — hard stop with partial artifact upload.
- Prompt injection: issue body and comments are **untrusted evidence**. System instructions and policy come only from Erik. Same boundary as RAG: retrieved text is never instructions.

### 9.4 Agent host responsibilities

The job process (Erik coding host):

1. Copy the mounted Grok subscription session outside `/workspace`; reject any `XAI_API_KEY`.
2. Download and verify the approved Git bundle and base SHA; remove its remote.
3. Write a run brief (`ISSUE.md`) from normalized ContextItems (issue + comments + linked files if any).
4. Start Grok ACP session with cwd = `repo/`.
5. Stream updates to `codingRuns/{id}/events/*`.
6. On agent stop: run project test command if configured (from repo policy or `erik.yaml` later).
7. If tests fail and attempts remain: optional second agent turn with failure logs.
8. Emit a patch and result Git bundle to GCS; mark run `awaiting_pr_approval`.
9. A separate approved GitHub action pushes/opens the PR; the runner never receives write credentials.

## 10. Opening pull requests

### 10.1 Typed action

```ts
// action.github.pr.create
{
  kind: "github.pr.create",
  connectionId: string,
  repoResourceId: string,
  owner: string,
  repo: string,
  headBranch: string,
  baseBranch: string,
  title: string,
  body: string,              // includes issue close keyword, run link, summary
  draft: boolean,
  issueNumber: number,
  codingRunId: string,
  headSha: string,           // expected remote tip for precondition
  idempotencyKey: string     // companyId + codingRunId + "pr.create"
}
```

Registry traits:

- `category: "external.write"`
- `requiresApproval: true` (always at descriptor level)
- Automation policy may supply a **pre-recorded decision** bound to policy digest + run digest only when `openPrRequiresApproval: false`
- `idempotency: "provider_aware"` — reconcile by branch + open PR search before create
- `reconciliation: "required_before_retry"`
- result: `{ prNumber, prUrl, nodeId, draft }`

### 10.2 PR body contract (minimum)

- Link to GitHub issue
- Link to Erik coding run (deep link in app)
- Policy version / digest
- Model id + token usage
- Test command + exit code
- Explicit “generated with Grok under Erik governance” footer
- List of assumptions / unresolved questions from the agent

### 10.3 What happens after PR open

- ContextItem `github.pr` upserted
- Issue comment optional (`github.issue.comment`) with PR URL
- Erik task → done / waiting for review
- Checks remain GitHub’s job; Erik can poll or webhook `check_suite` later (v1.1)

## 11. Data model (Firestore)

```text
companies/{companyId}
  connections/{connectionId}                 # github | grok_subscription
    resources/{resourceId}                   # repos
  contextItems/{contextItemId}               # issues, comments, PRs
  codingPolicies/{policyId}
    versions/{versionId}
  codingRuns/{runId}
    events/{eventId}                         # streamed agent updates (TTL/exportable)
  proposals / decisions / actionExecutions   # existing
  tasks/...                                  # optional queue visibility
```

### CodingRun (core fields)

```ts
type CodingRun = {
  id: string
  companyId: string
  status: CodingRunStatus
  github: {
    connectionId: string
    repoResourceId: string
    owner: string
    repo: string
    issueNumber: number
    issueUrl: string
    issueContextItemId: string
  }
  policy: { policyId: string; version: number; digest: string }
  grok: {
    connectionId: string
    authKind: "subscription_oauth"
    modelId: string
  }
  git: {
    baseBranch: string
    headBranch: string
    baseSha?: string
    headSha?: string
  }
  pr?: {
    number: number
    url: string
    draft: boolean
  }
  usage?: { inputTokens: number; outputTokens: number; durationMs: number }
  error?: { code: string; message: string; phase: string }
  createdAt: string
  updatedAt: string
}
```

Large transcripts go to GCS; Firestore holds status, pointers, and a tail of events for the UI.

## 12. UI surfaces

The complete product must expose the entire lifecycle in the authenticated web application. The shell scripts in CG0 are deployment/operator scaffolding, not the customer connection experience.

1. **Sources → GitHub**
   - install the GitHub App, select repositories, show permissions and webhook health;
   - disconnect/reconnect without exposing installation credentials.
2. **Sources → Grok subscription**
   - admin clicks **Connect Grok subscription**;
   - backend starts a short-lived auth-only worker and returns the device verification URL/code;
   - UI opens/copies the Grok verification step, polls connection state, and ends in `active`, `attention_required`, or `disconnected`;
   - show account label/team, last authentication, last successful run, and **Reconnect**/**Disconnect** controls;
   - never display, upload, or return `auth.json`, refresh tokens, or an xAI API-key field.
3. **Automation / Coding policies** (admin)
   - repository and label filters, concurrency/runtime/turn limits, approval toggles, draft-PR default;
   - policy preview and immutable published-version digest.
4. **Work queue**
   - coding runs as tasks: Queued / Provisioning / Running / Needs PR approval / PR opened / Failed / Cancelled;
   - clear subscription-attention state instead of a generic runner failure.
5. **Coding run detail**
   - issue evidence, current phase, bounded live event timeline, changed files/diff, model/turn/runtime metadata, and test evidence;
   - Cancel, Retry, Download artifact, Approve PR, Reject, and Request changes actions according to state;
   - approval shows the exact branch, base/head SHA, PR title/body, and disclosed external effects.
6. **Agent thread (optional)**
   - factual agent can answer “what’s the status of issue 128?” via ContextItems + CodingRun tools (read-only).

The auth-only worker must use a different service account from the coding runner. It may add a version to the one company-specific Grok subscription secret, but it receives no repository, GitHub, Firestore-wide, or coding-artifact authority. The normal coding Job remains unable to update its own subscription secret.

The deployed MVP uses a fixed secret assigned exclusively to one company in a
server-owned mapping. This is intentional for the current single-company
product; multi-company onboarding must provision a separate secret and
secret-scoped IAM binding per company rather than reusing this name. The auth
job needs 1 vCPU / 1 GiB: a live 512 MiB probe was OOM-killed during Grok CLI
startup.

## 13. Security and tenancy

- All user procedures derive `companyId` from membership. The public webhook
  accepts no tenant identifier; it verifies the signature and resolves the
  company + connection through a server-owned installation mapping, which the
  async worker verifies again.
- Browser never receives GitHub App private keys, installation tokens, or the Grok subscription session.
- Installation tokens are job-scoped and short-lived.
- Repo contents in the job are company data — logs/redaction policy for secrets detected in agent output (basic pattern scrubbing v1).
- Cross-company isolation tests mandatory (connection, run, webhook).
- Rate limits: max concurrent coding jobs per company; max claims/hour.

## 14. Implementation slices

Align with the connector epic style: one complete loop per slice.

**Implementation status (2026-08-01):** the CG0/CG3 runner foundation is deployed and verified on GCP: pinned Grok Build, subscription OAuth only, strict sandbox, separate Unix identities, signed Git-bundle/artifact transfer, 2 vCPU / 4 GiB, and a 10 GiB disk-backed ephemeral volume. A real smoke run produced one committed file and a verified result bundle. The CG1 read connector authenticates the configured GitHub App from Secret Manager, lists the installation's repositories, requires a separate Erik-side repository opt-in, and projects selected repositories' issues/comments into tenant-scoped ContextItems. Its signed webhook path is tenant-routed by installation, delivery-deduplicated, asynchronously processed, health-visible in Sources, and backed by 30-minute reconciliation. Installation tokens remain memory-only and the adapter rejects write permissions. CG1 is complete after the deployed webhook receives a live issue delivery and the product agent cites that issue. **CG2 is complete:** an administrator completed xAI device OAuth from Sources, the dedicated auth job validated the official `oidc` credential shape and stored it as Secret Manager version 2, the old version was disabled, and coding execution `erik-coding-runner-q5zc2` authenticated as `subscription_oauth` and produced exactly the requested one-file patch. No xAI API key is accepted, and the OAuth session reached neither the browser nor the repository workspace. CG3 still lacks the authenticated control-plane run record, GitHub branch publisher, and web run surfaces.

| Slice | Outcome | Exit criteria |
| --- | --- | --- |
| **CG0** | Spike: one repo, PAT or App, manual issue → local/container Grok → manual PR | Operator can complete loop offline; document ACP host gaps |
| **CG1** | GitHub observe connector in Erik | Selected repos’ issues as ContextItems; agent can cite an issue; disconnect deletes context |
| **CG2** | Grok subscription web connection + secret plumbing | Admin completes device OAuth from the web UI; coding job authenticates with cached state; API-key auth is disabled; session never reaches browser/workspace |
| **CG3** | Cloud Run Job coding host (no auto PR) | Manual “Implement” from an issue creates run, branch pushed, artifacts stored |
| **CG4** | Typed `github.pr.create` + approval card | Human approves exact title/body/branch; PR opens once; retry safe |
| **CG5** | Claim action + label policy | Label `erik-implement` auto-claims and queues run; audit shows policy digest |
| **CG6** | Policy-delegated PR (optional) | Repo with `openPrRequiresApproval: false` opens draft PR under published policy without per-run click |
| **CG7** | Operator recovery | Cancel run, retry failed, reconcile orphan branches/PRs, attention states on connection |

**Suggested first production path:** CG1 → CG2 → CG3 → CG4 (human-approved PRs) → CG5 (auto-claim only). Defer CG6 until trust is earned.

### Rough effort (order of magnitude)

| Slice | Eng days (1 senior) |
| --- | --- |
| CG0 spike | 2–3 |
| CG1 GitHub read | 4–6 |
| CG2 Grok connection | 1–2 |
| CG3 Job host | 6–10 |
| CG4 PR action + UI | 3–5 |
| CG5 Auto-claim | 2–4 |
| CG6 Delegated PR | 2–3 |
| CG7 Recovery | 2–4 |

Total to human-approved automated claim+PR loop: roughly **3–5 weeks** calendar with one focused engineer, excluding GitHub App review/org policy delays.

## 15. Dependencies and external setup

- GitHub App registration (name, permissions, webhook URL, private key in Secret Manager).
- Public HTTPS webhook endpoint (existing Functions/Cloud Run domain).
- Artifact Registry image for coding job (larger than API image; separate Dockerfile).
- Dedicated Grok subscription account (preferably company/Business) connected through device OAuth; no xAI API key.
- Optional: `erik-bot` GitHub identity / App bot attribution.
- CI on target repos should already run on `pull_request` for draft PRs.

## 16. Risks

| Risk | Mitigation |
| --- | --- |
| Prompt injection via malicious issue text | Strict system/policy vs evidence boundary; no credential tools in agent; network allowlist |
| Exhausted shared Grok subscription allowance or unbounded Cloud Run time | Turn/time/concurrency caps; draft-only; label opt-in; surface subscription attention state |
| Flaky or wrong PRs erode trust | Default human PR approval; draft PRs; required tests when configured |
| GitHub App permission creep | Split read/write product capabilities; incremental auth messaging |
| Long jobs vs platform timeouts | Cloud Run Jobs, not HTTP request handlers |
| Secret leakage in commits | Pre-push secret scan; block push on hit; scrub event logs |
| Conflicts with product “no automatic external effects” | Automation only via published policy digest + action registry; still fully audited |
| Grok CLI / ACP instability in containers | CG0 spike; pin CLI version in image; fallback headless `grok -p` if ACP host incomplete |

## 17. Alternatives considered

| Option | Why not first |
| --- | --- |
| GitHub Actions runner only (no Erik) | Loses tenancy, approvals, multi-source context, company UI |
| Laptop grok-remote only | Not multi-tenant cloud; no company audit |
| Gemini coding instead of Grok | Possible later; this proposal’s goal is Grok subscription + coding agent |
| Full auto-merge | Out of scope; review remains human/GitHub |
| Generic “run shell on Cloud Run” action | Too broad; prefer issue→PR coding contract |

## 18. Acceptance scenario (end-to-end)

1. Admin installs GitHub App on org `acme`, enables repo `acme/widget`.
2. Admin connects a dedicated Grok subscription through device OAuth; no xAI API key is stored.
3. Admin publishes policy: label `erik-implement`, auto-claim, **PR requires approval**, draft PR, base `main`.
4. Developer opens issue #42 with label `erik-implement`.
5. Within a minute Erik claims the issue (bot comment + label `erik-claimed`) and starts a coding job.
6. Work queue shows run Running; detail streams tool activity.
7. Job finishes; proposal card shows branch, summary, test results, exact PR title/body.
8. Approver clicks Approve; `github.pr.create` opens draft PR linking #42.
9. Audit shows policy digest, decision actor, execution result, PR number.
10. Disconnecting GitHub stops new claims and removes normalized context per connector rules; open PRs remain on GitHub.

## 19. Decision gates (before scheduling)

1. **Auth:** GitHub App vs user OAuth for v1? (**Recommend App.**)
2. **PR gate:** Always human for first production month? (**Recommend yes.**)
3. **Runtime:** Bundle Grok CLI in Job image vs xAI remote agent API only? (**Spike in CG0.**)
4. **Queue UX:** Separate Coding page vs Tasks only?
5. **Priority vs Gmail epic:** Does this interrupt C3–G3, or run as parallel R1 after C3?

## 20. Recommendation

Implement as a **new coding-agent epic** (`CG0–CG7`) that:

- reuses the connector + action + approval kernels;
- adds GitHub observe + execute capabilities and a Grok provider connection;
- introduces a Cloud Run Job coding host;
- ships **auto-claim + human-approved draft PRs** first;
- only then considers policy-delegated PR opening.

This matches Agent Erik’s product promise: agents do the work, people (or explicit policy) remain accountable for consequential GitHub effects, and every step is inspectable.

## 21. Next concrete step

If accepted, start **CG0** as a spike branch:

1. Dockerfile with git + grok CLI.
2. Script: immutable run spec + signed Git bundle → headless Grok subscription run → patch/result bundle artifact.
3. Record wall time, failure modes, and secret handling notes.
4. Promote findings into CG1–CG4 detailed tickets without expanding product scope.

---

*Authoring note: this document is a proposal only. It does not change the connector epic status or schedule until product accepts the decision gates in §19.*
