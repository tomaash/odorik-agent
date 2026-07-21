# Odorik transcription spike

This spike receives completed Odorik call recordings, stores them privately,
transcribes and summarizes them with Gemini Flash-Lite, persists application
data in Firestore Enterprise, and exposes an authenticated tRPC dashboard.

## Services

- `odorik-ingest`: public HTTP integration secured with dedicated Basic
  credentials. It accepts Odorik's `multipart/form-data` recording upload.
- `odorik-processor`: private Eventarc destination. It transcribes new Cloud
  Storage objects with `gemini-3.1-flash-lite`.
- `odorik-api`: tRPC API and minimal browser dashboard secured by a dashboard
  token.

Audio lives in a private Cloud Storage bucket and is deleted after 30 days.
Call metadata and transcripts live in the named `odorik` Firestore Enterprise
Native mode database. Call documents carry a 90-day `expiresAt` value and the
database TTL policy removes them automatically.

## Live spike

- Google Cloud project: `odorik-tx-260720-c58d`
- Dashboard: <https://odorik-api-apf5skngva-ey.a.run.app/>
- Region: `europe-west3`

The dashboard token and Odorik upload credentials are stored in Secret Manager.
The configured Odorik destination uses the dedicated ingest service with the
`!opus` format suffix; no SIP PBX or Asterisk service is involved.

## Local checks

```bash
npm install
npm test
```

## Deployment

`infra/bootstrap.sh` creates the isolated project infrastructure.
`infra/deploy.sh` builds and deploys the three Cloud Run services.
`scripts/smoke-test.sh` generates a synthetic call and submits it through the
same HTTP endpoint Odorik uses.

Secrets belong in Secret Manager and must never be committed. The local `.env`
file is ignored.
