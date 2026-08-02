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

## Firestore records

```text
companies/{companyId}
  connections/{connectionId}
    capabilities/{serviceId}
    resources/{resourceId}
    syncRuns/{runId}
      resourceAttempts/{attemptId}
  contextItems/{contextItemId}

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
3. Later runs request only changes.
4. HTTP 410 clears an expired token and starts a bounded full sync.
5. Cancelled events delete their context.
6. Deselecting a calendar deletes its normalized context.
7. A private scheduled function reconciles every 30 minutes.

Calendar, Drive, and GitHub polling reconciliation create durable capability
runs with immutable per-resource attempts. A fenced lease prevents two workers
from committing the same resource concurrently. Transient failures retry after
1, 5, and 30 minutes; exhausted or permanent failures become visible attention
state and an administrator can replay the failed run from Sources. Run commits
re-check the connection and resource lifecycle so an in-flight worker cannot
revive a disabled, disconnected, or deleted source. Run and attempt history is
retained for 90 days. A request arriving during an active run is coalesced into
one safe successor when it includes a newly selected resource.

Calendar events are visible to all members of their company. Do not connect a
calendar that should be visible to only some team members until
restricted member ACL filtering is implemented.

## Google Drive adapter

OAuth currently uses `drive.readonly`. After authorization, an administrator
explicitly selects folders; nothing is selected implicitly. The deployed
implementation imports non-folder files that are direct children of each
selected folder. It extracts Google Docs and text-like files and otherwise
stores searchable metadata plus a provider link.

Drive sync runs when a folder is selected, when an administrator requests it,
and every 30 minutes. Each selected folder is an independently leased full
reconciliation. Healthy folders finish while a failing folder retries. After a
complete direct-child enumeration, context for files deleted, trashed, moved
out of that folder, or no longer visible is removed. Supported Google Docs and
text extraction failures are actionable; unsupported binaries remain honest
metadata-only records. `source.resourceId` uses the same hashed internal folder
identity as the resource document.

Recursive selection, overlapping-root deduplication, PDF extraction, and
restricted member audiences are not yet implemented. Their order and
acceptance criteria are defined in `CONNECTOR_EPIC.md`.

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
- Firestore write triggers attempt Qdrant synchronization after every
  normalized context write or deletion. Firestore remains authoritative;
  durable delivery state and measured context-to-search freshness remain C3C.
- Calendar, Drive, and GitHub expose distinct syncing, retrying, stale, fresh,
  and attention state with separate attempt, success, change-observed, and
  reconciliation timestamps.

Google Auth Platform is currently in testing mode. Only listed test users may
authorize Calendar, and refresh tokens expire after seven days. Complete OAuth
verification before general use.
