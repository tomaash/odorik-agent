# Agent Erik coding dispatcher

This trusted Cloud Run Job has two explicit modes. Dispatch mode converts one
approved GitHub issue into the immutable input contract consumed by
`coding-runner`. Publish mode validates the approved base/result SHAs, result
bundle checksum, deterministic branch, and original approval digest, then
pushes that branch and opens one draft pull request idempotently.

It may read the GitHub App private key, impersonate the dedicated coding URL
signer, and execute only the coding runner Job. It has no Grok secret and no
Firestore access. Dispatch mode refetches the issue and repository, refuses an
issue version or base SHA that changed after approval, creates a Git bundle
without executing repository content, and starts the runner. Publish mode
never executes repository code and mints a short-lived GitHub token restricted
to the one approved repository and Contents/Pull requests write.

The GitHub installation token remains process-memory-only. The runner receives
only signed object URLs and never receives a GitHub credential. Grok
subscription OAuth is available only to the runner and is never mounted here.
