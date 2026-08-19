# Microsoft Partner Center publication blocker

**Status:** external release blocker; Microsoft support request
`2608180010001212` is open and awaiting advocate review

**Observed:** 2026-08-18

## Blocked outcome

Slice 14 is deployed and packaged, but Agent Erik cannot complete its real
Microsoft Teams desktop/mobile acceptance until the app can be submitted to the
Teams Store through Partner Center's **Microsoft 365 and Copilot** program.

This is a hard availability and testability boundary: Teams is not currently
available as a product surface, and there is no supported way to install or
exercise the app in a real Teams client while support request
`2608180010001212` remains unresolved. Automated tests, webhook checks, and the
deployed Azure bot prove code and infrastructure behavior only; they must not be
reported as Teams client acceptance.

The product implementation is not waiting on more bot code. The blocked chain
is:

```text
Microsoft AI Cloud Partner Program enrollment
→ Microsoft 365 and Copilot publisher enrollment
→ Teams Store submission and review
→ published-app desktop/mobile acceptance
```

## What is already complete

- The production Azure Bot, Teams channel, webhook routes, Google Secret
  Manager credentials, public privacy/terms pages, and versioned Teams package
  are deployed.
- `teams-app/agent-erik-teams-1.0.0.zip` is the Store-ready package.
- The Microsoft Entra tenant uses verified primary domain `headstart.cz`.
- The Global Administrator signs in as `tomas@headstart.cz`.
- Tenant ID: `e34ce9b3-1f8a-40cc-b3ec-fa6993c2d5f9`.
- Domain verification added only Microsoft's TXT ownership record. Existing
  Lark MX/mail delivery records were deliberately left unchanged.

## What failed

The first Partner Center enrollment attempt was rejected by Microsoft's
automated trust evaluation before a Partner Center workspace was created:

- reference number: `715-123160`;
- transaction ID: `50a8fb98-8a97-49c2-ac9a-011ee8cd5d25`;
- correlation ID: `b726c105-5901-4b95-b2aa-4c282ec6cbae`.

Microsoft's error linked to generic support rather than an appeal tied to the
rejection. The normal Partner Center support workspace was also unavailable
because enrollment had not created a workspace.

A stale Microsoft browser session initially displayed the tenant's original
`tholas.onmicrosoft.com` identity even though the user's UPN and tenant primary
domain had already changed. A scoped sign-out removed only that tenant session;
after signing in again, Entra correctly showed `tomas@headstart.cz`, primary
domain `headstart.cz`, the expected tenant ID, and the Global Administrator
role. This established that the custom domain and UPN change are healthy and
are not the publication blocker.

The clean retry reached Partner Center's program selector and exposed the
correct **Microsoft 365 and Copilot** option, described by Microsoft as the
program for extending Teams, Office, SharePoint, and Microsoft 365 Copilot with
apps, plugins, and connectors. The enrollment UI then became unusable before
the application could be completed. No successful enrollment, publisher ID, or
Partner workspace resulted from the retry.

## Open support request

- request number: `2608180010001212`;
- title: `Partner Center enrollment blocked — Trust code 715-123160 — manual review required`;
- status: **Open**;
- issue type: **Unable to login to Partner Center** (the available no-workspace
  support route, not the actual diagnosis);
- opened: `2026-08-18 16:44:15 UTC` (`18:44:15 Europe/Prague`);
- last known modification: `2026-08-18 16:44:15 UTC`;
- contact email: `tomas@headstart.cz`.

The submitted request explicitly states that authentication works and that the
actual failure is the automated trust block before Partner Center workspace
creation. It asks Microsoft to:

1. route the case to **Partner Vetting / Trust & Safety**;
2. manually review the automated trust block;
3. unblock or reset enrollment so business verification can be completed; and
4. identify the exact documents or enrollment details required.

The request includes the trust reference, transaction and correlation IDs,
Entra tenant ID, Global Administrator, verified `headstart.cz` domain, Czech
Republic, and the Teams Store publication purpose. It offers business
registration, address, identity, and domain-ownership evidence through a secure
Microsoft upload channel. It also warns against closing the case as a generic
sign-in issue.

Microsoft says a support advocate will review the request and contact the
provided email address to begin troubleshooting.

## Support route

Microsoft documents a no-workspace support path under:

`User and role management > Unable to login to Partner Center`

Direct form:

<https://partner.microsoft.com/en-us/support?stage=2&topicid=6b52f3cf-3b36-df07-f75b-27aa68bf8a01>

This is the route used to create request `2608180010001212`. Do not create a
duplicate request while it remains open.

## Do not change while blocked

- Do not remove `headstart.cz` from Entra or change the primary UPN back to the
  `onmicrosoft.com` name.
- Do not change Lark MX, SPF, DKIM, or mail-routing records for this issue.
- Do not create another Entra tenant or another Partner Center identity.
- Do not broaden the Teams bot beyond personal scope to work around Store
  publication.
- Do not mark Slice 14 accepted until the published app passes its real client
  acceptance scenario.

## Resume checklist

1. Sign in to Entra as `tomas@headstart.cz` and confirm tenant
   `e34ce9b3-1f8a-40cc-b3ec-fa6993c2d5f9` with primary domain `headstart.cz`.
2. Monitor `tomas@headstart.cz` for responses concerning support request
   `2608180010001212`; preserve all replies and requested-document details here.
3. Follow only the vetting team's requested verification path; avoid blind
   enrollment retries while the trust block is unresolved.
4. When enrollment is active, join **Microsoft 365 and Copilot**, create or
   select the publisher identity, and submit the versioned Teams package.
5. After publication, complete Slice 14's personal-chat, desktop/mobile card,
   identity-link revocation, uninstall, and connector-deletion acceptance.
