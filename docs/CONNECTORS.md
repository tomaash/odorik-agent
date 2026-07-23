# Source connectors

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
independently selectable source inside that account.

Firestore remains authoritative. Qdrant contains derived search chunks and can
be rebuilt.

## Firestore records

```text
companies/default
  connections/{connectionId}
    resources/{resourceId}
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
POST /webhooks/odorik/{connectionId}/recordings
```

The connection username and password are encrypted in Firestore. The ingest
service decrypts them only while authenticating that request. Calls from
different accounts cannot collide: non-legacy Firestore IDs derive from
connection ID plus provider call ID.

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
the ones to ingest. Nothing is selected implicitly.

For each selection:

1. Initial sync imports event instances from the previous year onward.
2. The returned `nextSyncToken` is stored on the calendar resource.
3. Later runs request only changes.
4. HTTP 410 clears an expired token and starts a bounded full sync.
5. Cancelled events delete their context.
6. Deselecting a calendar deletes its normalized context.
7. A private scheduled function reconciles every 30 minutes.

Calendar events are company-visible in this single-company deployment. Do not
connect a calendar that should be visible to only some enabled users until
restricted member ACL filtering is implemented.

## Operations

- `sources.list` is available to enabled members.
- Adding, disconnecting, selecting, excluding, and manual sync require an
  application administrator.
- Refresh tokens and Basic-auth passwords never enter model prompts or browser
  API responses.
- Firestore write triggers keep Qdrant synchronized after every normalized
  context write or deletion.
- Adapter errors move a connection to `attention` and retain the last error.

Google Auth Platform is currently in testing mode. Only listed test users may
authorize Calendar, and refresh tokens expire after seven days. Complete OAuth
verification before general use.
