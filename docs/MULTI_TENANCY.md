# MVP multi-tenancy

## Product contract

The MVP has one team per user and no self-service team creation or team
switcher.

- A person who signs in with Google without an invitation remains registered
  but pending.
- Any active team member may invite an email address.
- The recipient must sign in with the same verified Google email and explicitly
  accept the invitation.
- Invitations expire after seven days and can be resent or revoked.
- An administrator may remove a member. Members cannot remove themselves or an
  administrator.
- The first team is `Explorers`: Tom is administrator; Josef and Katarina are
  members.

These constraints prove the collaboration and isolation loop without adding
billing, team discovery, multiple-team membership, ownership transfer, custom
roles, or a permission editor.

## Authoritative boundary

Firebase Auth proves identity. Server-side membership selects the only company
the request may access:

```text
users/{uid}
  activeCompanyId

companies/{companyId}
  memberships/{uid}
  invitations/{invitationId}
  calls/{callId}
  interactions/{interactionId}
  contacts/{contactId}
  serviceRequests/{requestId}
  processingRuns/{runId}
  tasks/{taskId}
  reviews/{reviewId}
  auditEvents/{eventId}
  agentThreads/{threadId}/messages/{messageId}
  agentRuns/{runId}
  connections/{connectionId}/resources/{resourceId}
  contextItems/{contextItemId}
```

The client never chooses `companyId`. Every enabled tRPC procedure resolves it
from `users/{uid}` and the matching active membership. Direct browser
Firestore access remains denied.

Recording webhook URLs include both company and connection:

```text
POST /webhooks/odorik/{companyId}/{connectionId}/recordings
```

Storage objects use `recordings/{companyId}/{callId}/{file}`. Firestore
triggers, CRM processing, connector sync, and source projections carry the
company from their event or authorized connection.

## Search isolation

Firestore is authoritative. Qdrant uses one shared, versioned
`company_context_v5` collection:

- every chunk ID begins with its company ID;
- every point has a `companyId` payload;
- `companyId` has a Qdrant tenant keyword index;
- delete, update, rebuild, dense search, and BM25 search all include the
  company filter; and
- returned payloads are checked again and discarded if their company does not
  match the request.

The application rejects mixed-company tenant rebuilds.

## Invitation security

Only the SHA-256 digest of the random invitation secret is stored. The secret
appears once in the emailed link and is removed from the browser URL into
session storage before API inspection. Acceptance runs in a Firestore
transaction and verifies:

- the invitation is pending and unexpired;
- the token digest matches using a timing-safe comparison;
- the Firebase email is verified and exactly matches the invited email;
- the user is not already attached to another team; and
- the membership and consumed invitation are committed together.

Resend is called only by the server. The API key is stored in local `.env` for
development and Google Secret Manager for deployed Functions. The temporary
`onboarding@resend.dev` sender is suitable for Resend-account testing; a
verified product domain is required before delivery to arbitrary recipients.

## Migration and rollback

The production migration is additive:

1. Copy legacy company data into `companies/explorers/...`.
2. Create exactly the three verified Explorers memberships.
3. Build and verify Qdrant v5 from the tenant-scoped records.
4. Deploy the company-scoped Functions, frontend, ingestion, and processing
   services.
5. Keep the old Firestore records and Qdrant v4 collection during validation.

A temporary call bridge copies writes made by the old recording containers
during the rolling deployment into Explorers. The old records are not deleted
by the migration, so rollback can restore the previous application revision
without reconstructing data.

## Deliberate MVP omissions

- creating, renaming, deleting, or switching teams;
- belonging to several teams;
- custom roles or per-feature permissions;
- transferring the administrator role;
- invitation directories or domain auto-join;
- billing, seats, SSO, SCIM, or organization policies; and
- per-member source ACL controls.

Add these only after a second real team proves that shared data, invitations,
and strict isolation solve the core problem.
