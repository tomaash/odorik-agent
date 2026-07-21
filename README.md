# Odorik CRM

Odorik CRM turns recorded phone calls into reviewable service requests. Odorik
uploads each completed recording directly to a private Cloud Run endpoint, so
the system does not require Asterisk, a SIP server, or a speaking agent.

## Live application

- CRM: <https://odorik-tx-260720-c58d.web.app>
- Google Cloud project: `odorik-tx-260720-c58d`
- Region and Firestore location: `europe-west3`
- Database: named Firestore Enterprise database `odorik`
- Extraction model: `gemini-3.1-flash-lite`

The former token dashboard remains deployed at
<https://odorik-api-apf5skngva-ey.a.run.app> while the CRM is being accepted.

## Flow

1. `odorik-ingest` accepts Odorik's authenticated multipart recording upload.
2. A private bucket stores the audio and emits an Eventarc event.
3. `odorik-processor` transcribes and summarizes the call with Gemini.
4. The `processCallCrm` Firestore trigger creates an interaction, deterministic
   phone contact, proposed service request, processing run, and review task.
5. A signed-in, enabled person reviews the proposals against linked transcript
   evidence. Only that approval writes canonical CRM fields.

The Vue application calls one Firebase Gen 2 HTTP function through tRPC. Browser
Firestore access is denied; authentication and authorization are checked in the
API on every request.

## Access control

Google sign-in authenticates identity but does not grant CRM access. On first
sign-in, the API creates:

```text
access/{firebaseUid}
  enabled: false
  admin: false
```

To authorize someone, open the named `odorik` database in Firebase Console,
find their document in the `access` collection, and change `enabled` to `true`.
There is deliberately no approval screen or bootstrap exception in the app.

## Data and retention

- Audio is private and deleted by bucket lifecycle after 30 days.
- Calls, interactions, and Gemini processing runs carry `expiresAt` and have
  Firestore TTL policies. Evidence data expires after 90 days.
- Contacts, canonical service requests, reviews, tasks, and audit events are
  retained as business records.
- Gemini and integration credentials live in Secret Manager and are never sent
  to the browser or committed.

## Repository

- `src/`, `Dockerfile.*`, `infra/`: recording ingestion and transcription spike
- `functions/`: Firebase Auth context, tRPC router, CRM extraction and review
- `frontend/`: Vue 3, TypeScript, Pinia, PrimeVue, Tailwind, and Firebase Auth
- `firestore.rules`, `firestore.indexes.json`: named-database security, indexes,
  and TTL policies

## Local verification

```bash
npm install
npm test

npm --prefix functions ci
npm --prefix functions test

npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

## Deployment

Firebase resources can be deployed manually with:

```bash
functions/node_modules/.bin/firebase deploy \
  --only functions:crm,firestore:odorik,hosting \
  --project odorik-tx-260720-c58d
```

Pushes to `main` also deploy through GitHub Actions. The workflow uses Google
Workload Identity Federation scoped to `tomaash/odorik-agent`; it has no service
account key. GitHub contains only the provider resource name and deploy service
account address.

The Odorik destination, its recording format, and existing production secrets
must not be changed as part of ordinary CRM deployments.
