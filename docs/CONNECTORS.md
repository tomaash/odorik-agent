# Source connectors

Current implementation sequencing, hardening work, and provider decision gates
are defined in `CONNECTOR_EPIC.md`. This document describes deployed behavior.

## Runtime model

```text
adapter code
  └── company connection
        └── selected resources
              └── source records
                    └── normalized context items
```

An adapter understands one provider API. A connection represents one account
and stores non-sensitive public state plus an AES-GCM credential envelope. The
envelope key is a 32-byte value in Secret Manager. A resource is the smallest
independently selectable source inside that account. A company can create any
number of connections for the same adapter; each account appears as its own
card and retains its own credentials, resources, health, and sync cursor.

Firestore remains authoritative. Qdrant contains derived search chunks and can
be rebuilt.

## C4 permission-aware resources and context

Every selected resource now has an application audience: all active company
members or an explicit non-empty set of active member IDs. Existing Calendar,
Drive, GitHub, and Odorik resources remain company-visible unless an
administrator changes them. Sources displays and edits the audience, requires
a second confirmation before access is broadened, and reports that the
normalized projection will be re-indexed.

The audience is copied to normalized context and raw calls. For call-derived
tasks, approvals, cases, workflow runs, coding runs, and evidence events, the
same access envelope is retained. Exact lookup, list, aggregate, hybrid vector
and lexical search, citations, coding views, workflow history, contact call
evidence, and case evidence all authorize the requesting member. Qdrant applies
tenant and member filters, and every vector result is checked again against
authoritative Firestore before it can become a tool result or citation. This
closes the asynchronous re-indexing window after access is narrowed.

Audience edits bump a revision and rewrite source projections so the existing
Firestore-to-Qdrant delivery path re-indexes them. Disabling or deleting a
resource marks raw, normalized, and linked retrieval records ineligible before
the vector deletion settles. The one-time migration is dry-run by default:

```bash
npm --prefix functions run migrate:resource-audiences -- --company=COMPANY_ID
npm --prefix functions run migrate:resource-audiences -- --company=COMPANY_ID --apply
```

Agent chat threads are separate from resource audiences but follow the same
privacy invariant: thread document identities are namespaced by member, thread
lists query only the authenticated owner, and each member can create and switch
among their own chats.

## Firestore records

```text
companies/{companyId}
  connections/{connectionId}
    capabilities/{serviceId}
    resources/{resourceId}
    syncRuns/{runId}
      resourceAttempts/{attemptId}
  contextItems/{contextItemId}
  knowledgeIndexDeliveries/{deliveryId}

oauthStates/{stateHash}
```

A context item records company and source kind; adapter, connection, resource,
and provider object IDs; searchable text; timestamps; participants; access;
safe structured metadata; and provenance with checksum and ingestion version.

## Odorik adapter

The compatibility callback remains:

```text
POST /odorik/recordings
```

It maps to `odorik-primary` and uses the existing Cloud Run Basic-auth secrets.
A new account uses:

```text
POST /webhooks/odorik/{companyId}/{connectionId}/recordings
```

The application generates the connection username and password and presents an
administrator with one paste-ready Odorik destination:

```text
https://{user}:{password}@{host}/webhooks/odorik/{companyId}/{connectionId}/recordings!mp3
```

For every Odorik line to import, paste that complete value into the line
setting `Email pro zasílání nahraných hovorů [?]` and enable call recording on
the same line. No Odorik API credentials or advance list of phone numbers is
required. The destination credentials are encrypted in Firestore and revealed
only to an administrator on request; the ingest service decrypts them only
while authenticating an upload. Calls from different accounts cannot collide:
non-legacy Firestore IDs derive from connection ID plus provider call ID.

Phone-line resources are discovered from `line_name`, falling back to the
called number and finally an unassigned line. Excluding a line removes its
context from retrieval without deleting the raw call or recording.

## Google Calendar adapter

OAuth uses only:

```text
calendar.calendarlist.readonly
calendar.events.readonly
```

After OAuth, the administrator sees accessible calendars and explicitly checks
the ones to ingest. Nothing is selected implicitly. Starting another Calendar
connection always opens Google's account chooser. The primary calendar
identity labels the resulting account card; authorizing the same Google account
again refreshes that connection instead of creating a duplicate card.

For each selection:

1. Initial sync imports event instances from the previous year onward.
2. The returned `nextSyncToken` is stored on the calendar resource.
3. Later runs request only changes with the same expanded-instance and deleted
   event contract across every page.
4. HTTP 410 marks a bounded full rebuild, enumerates a complete replacement
   snapshot, reconciles stale observations, and commits the replacement token
   only after the final page succeeds.
5. Recurring instances retain their series ID, original start time, iCal UID,
   sequence, event type, and cancellation metadata. Cancelling one occurrence
   removes only its deterministic instance; series deletion removes every
   returned cancellation or stale instance.
6. Content no-ops do not rewrite context, while provider version, source
   ownership, audience, and audience revision changes still reconcile.
7. Deselecting a calendar deletes its normalized context.
8. A private scheduled function reconciles every 30 minutes.

Google API and refresh failures are normalized into sanitized typed errors.
Network failures, rate limits, and server errors follow bounded retry. An
expired Calendar cursor is recovery rather than reauthorization. Invalid
grants, a repeated provider 401 after forced refresh, or a missing capability
scope produce explicit account/capability reauthorization state; inaccessible
selected resources produce scoped permanent attention instead. Same-identity
reauthorization preserves resources, cursors, context, and audiences and queues
their reconciliation.

Calendar, Drive, and GitHub polling reconciliation create durable capability
runs with immutable per-resource attempts. A fenced lease prevents two workers
from committing the same resource concurrently. Transient failures retry after
1, 5, and 30 minutes; exhausted or permanent failures become visible attention
state and an administrator can replay the failed run from Sources. Run commits
re-check the connection and resource lifecycle so an in-flight worker cannot
revive a disabled, disconnected, or deleted source. Run and attempt history is
retained for 90 days. A request arriving during an active run is coalesced into
one safe successor when it includes a newly selected resource.

Calendar resources remain company-visible by default for compatibility, and an
administrator can restrict each selected calendar to specific active members.
Every incremental page, cancellation, full rebuild, stale deletion, and
re-index uses that resource's current audience and revision behind the same
connection/resource lifecycle and lease fences.

## Google Drive adapter

OAuth uses `drive.readonly`. After authorization, an administrator explicitly
selects folders; nothing is selected implicitly. Each enabled selected folder
is traversed recursively with pagination, visited-folder protection, shared
Drive request flags, and bounded depth/item/page work. A selected descendant
owns its subtree, so overlapping parent and child roots never produce duplicate
context. Disabled descendants remain exclusion boundaries. The closest
selected ancestor owns each provider file, with deterministic resource-ID
tie-breaking.

Drive sync runs when a folder is selected, when an administrator requests it,
and every 30 minutes. Each selected folder is an independently leased full
reconciliation. Healthy folders finish while a failing folder retries. Stale
context is removed only after complete traversal and extraction; partial
enumeration, safety-limit breach, extraction failure, or invalidated selection
generation cannot advance reconciliation or delete unseen items. Creation,
update, rename, move, trash, provider deletion, ownership transfer, root
disable/re-enable, and deselection converge on one canonical context ID per
provider file within the connection and document capability. Stored context,
not the latest page, determines each root's item count.

Google Docs export as text; text and Markdown blobs download as plain text.
Text-bearing PDFs up to 15 MB are converted to semantic Markdown by exactly
pinned `@pdf2md/core` 0.3.0 with a 45-second conversion limit and the common
50,000-character content ceiling. Image-only and policy-limited PDFs, plus
unsupported binaries, remain explicitly metadata-only with MIME type,
description, size, modified time, and provider link. A malformed or failed
supported extraction is actionable and prevents stale reconciliation rather
than pretending the file was read.

Administrators can restrict each selected folder to specific active members.
Ownership transfers copy the destination root's current audience and revision;
a selection change that would broaden retained content requires a second
confirmation against the current selection revision.

## GitHub adapter

GitHub App installation repositories remain explicitly selectable in Erik.
Manual and 30-minute polling synchronization use one durable run per Issues
capability and one fenced attempt per enabled repository. A repository failure
does not stop healthy repositories; polling removes issues no longer returned
only after complete repository enumeration. Five-minute recovery retries only
failed repositories, and permanent failures can be replayed by an
administrator.

Signed GitHub webhooks remain a separate idempotent event-delivery lane. Their
delivery health is shown separately and never substitutes for a successful
full repository reconciliation. If polling currently holds a repository lease,
the retry-enabled webhook worker defers its transactional context mutation until
that reconciliation finishes so an older poll snapshot cannot overwrite a newer
event.

## Microsoft 365 connection foundation

Microsoft 365 uses the server-side authorization-code flow against the
`organizations` authority. Every request has an unguessable hashed state,
encrypted PKCE verifier, S256 challenge, and OIDC nonce. The callback validates
the ID-token signature, audience, issuer, nonce, tenant ID, and Entra object ID,
then independently confirms that object with Microsoft Graph `/me`. A stable
connection binds exactly one company, tenant, and member; another capability
grant must return as that same identity.

The identity connection requests only `openid profile email offline_access
User.Read`. Outlook permissions are dynamic and separate:

- mail evidence foundation: delegated `Mail.Read`;
- draft foundation: delegated `Mail.ReadWrite`, which can create and modify a
  draft but does not include `Mail.Send`; and
- no Microsoft flow requests `Mail.Send`.

Slice 11 records these grants as `permission_granted`, not `active`. This is an
intentional correctness boundary: the permission and token lifecycle exist,
but Outlook ingestion and the approval-gated draft executor do not become
operational until Slice 12 proves their complete loops. An administrator can
locally disable/re-enable an already granted capability without changing the
tenant grant.

Refresh responses atomically replace the encrypted refresh token and advance a
credential revision. A concurrent refresh cannot overwrite a newer envelope.
Manual health verification forces a rotation, calls `/me`, and rechecks the
bound member. Consent denial, admin consent, Conditional Access, revoked grant,
expired refresh, and tenant/member mismatch are persisted as distinct recovery
states without exposing provider tokens or raw sign-in detail.

Disconnect deletes Erik's encrypted credential and all local capability and
context state. Microsoft does not offer a least-privilege endpoint for an app
to delete its own delegated grant: Graph grant deletion requires powerful
directory grant-management permission and an administrator role. Erik does not
request that permission. A user or tenant administrator can additionally
remove consent through Microsoft My Apps or Entra.

## Operations

- `sources.list` is available to enabled members.
- Adding, disconnecting, deleting, selecting, excluding, and manual sync require an
  application administrator.
- Disconnecting pauses synchronization but retains the account setup and
  imported context. Deleting is permanent inside this application: it revokes
  provider access when supported, removes encrypted credentials and resources,
  deletes normalized context, lets the Firestore trigger remove derived Qdrant
  chunks, and records an audit event. It never deletes originals at the
  provider.
- Refresh tokens and Basic-auth passwords never enter model prompts or browser
  API responses.
- Firestore write triggers create one deterministic durable Qdrant delivery
  state per indexed record. The worker re-reads authoritative Firestore,
  applies an idempotent record upsert or deletion, and records the generation,
  attempt, outcome, point count, and context-to-search delay. Transient
  failures retry after 1, 5, and 30 minutes; permanent or exhausted failures
  become administrator-visible attention state with targeted replay. A
  five-minute recovery worker reclaims stale leases. Existing records can be
  queued once from Sources when durable tracking is first deployed.
- Calendar, Drive, and GitHub expose distinct syncing, retrying, stale, fresh,
  and attention state with separate attempt, success, change-observed, and
  reconciliation timestamps.
- Connector health confirms provider-to-Firestore reconciliation. The separate
  search-index card confirms Firestore-to-Qdrant delivery; neither one is
  allowed to overwrite or stand in for the other.
- Calendar and Drive observations retain run, trigger, observed time, provider
  update time, and provider version. The durable index delivery samples each
  eligible provider version once and reports provider-to-context,
  context-to-search, and source-to-search p95 by capability and trigger.
  Historical backfill is excluded. Sources compares manual changes with a
  two-minute target and scheduled polling with a 45-minute target.

## C5 test-production evidence

On 2026-08-02 a real recurring Calendar series reconciled from two expanded
instances to one after a single-occurrence cancellation, returned a cited
agent answer, recovered a deliberately expired sync token through a successful
full-cursor rebuild, and then reconciled to zero after provider deletion. A
real nested Drive PDF converted through `@pdf2md/core`, returned a cited answer,
remained one canonical record while overlapping roots transferred ownership,
and disappeared from exact and hybrid retrieval after its subtree moved to
recoverable trash. Scheduler samples reached search in 14.904 seconds for
Calendar and 32.791 seconds for Drive. The active fixture was restored to
`České svátky` with 341 company-visible items and `test` with one
company-visible item; search settled at 519/519, zero pending, zero
intervention, and 16-second p95 context-to-search. The C4 migration was not run
again.

Google Auth Platform is currently in testing mode. Only listed test users may
authorize Calendar, and refresh tokens expire after seven days. Complete OAuth
verification before general use.
