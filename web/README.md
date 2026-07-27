# Agent Erik — website

Public marketing site. Statically generated with Nuxt 4, deployed to Firebase
Hosting. Mirrors the stack and deployment strategy of `appheadstart/web`.

Content source of truth: [`../docs/WEBSITE_CONTENT_PROPOSAL.md`](../docs/WEBSITE_CONTENT_PROPOSAL.md).

## Stack

- **Framework:** Nuxt 4, static preset (fully prerendered, no server at runtime)
- **Styling:** Tailwind CSS — dark theme, amber accent (`brand.400` = `#f2a93b`)
- **i18n:** `@nuxtjs/i18n`, `no_prefix` strategy, one build per locale
- **Hosting:** Firebase Hosting, two sites (CZ + EN)

## Development

```bash
npm install       # see "npm note" below
npm run dev       # http://localhost:3000 — defaults to EN

DEFAULT_LOCALE=cs npm run dev    # Czech build
```

## Pages

| EN | CZ |
| --- | --- |
| `/` | `/` |
| `/how-it-works` | `/jak-to-funguje` |
| `/privacy` | `/soukromi` |

Both locales' routes exist in every build; the nav points at the right ones via
`app/composables/useSitePaths.ts`. Each localised page is a thin wrapper around a
shared content component (`HowItWorksContent.vue`, `PrivacyContent.vue`) so the
markup lives in one place.

## Build

Locale is baked in at build time and drives the output directory:

```bash
npm run generate:cs    # → .output-cs/public
npm run generate:en    # → .output-en/public
```

## Deploy

Hosting config lives in the **repo root** `firebase.json` and uses deploy
targets from the root `.firebaserc`:

| Target | Site | Serves |
| --- | --- | --- |
| `frontend` | `odorik-frontend` | the app (`frontend/dist`) |
| `web` | `odorik-web` | this site (`web/.output-en/public`) |

Automatic via `.github/workflows/deploy-web.yml` on push to `main` touching
`web/**`. It builds both locales and deploys `--only hosting:web`, so the app's
`frontend` target is never touched.

### Open item: the Czech site has nowhere to deploy yet

The build produces **both** `.output-cs` and `.output-en`, but only one hosting
target (`web`) exists, currently pointed at the **English** output. Czech is
built and then discarded.

To ship CZ, create a second site and target, then add a matching entry to the
root `firebase.json` hosting array:

```bash
firebase hosting:sites:create odorik-web-cs --project odorik-tx-260720-c58d
firebase target:apply hosting web-cs odorik-web-cs --project odorik-tx-260720-c58d
```

```jsonc
{
  "target": "web-cs",
  "public": "web/.output-cs/public",
  "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
  "rewrites": [{ "source": "**", "destination": "/index.html" }]
}
```

Then change the workflow's deploy step to `--only hosting:web,hosting:web-cs`.

Don't add that entry before the target exists — Firebase fails on an unknown
target and the whole deploy aborts.

### Domains

`agenterik.cz` / `agenterik.com` in `nuxt.config.ts` `runtimeConfig.public` are
placeholders. Update `siteHostCs` / `siteHostEn` once the real domains are
attached — they're currently unused by the UI (the language switcher toggles
locale in place rather than crossing domains) and are kept for `hreflang`
alternates, which are still to add.

## Design-partner form

`app/components/PartnerForm.vue` posts JSON to
`runtimeConfig.public.partnerFormUrl`. That is **empty**, so today the form falls
back to opening the visitor's mail client with the fields prefilled — nothing is
dropped silently, and no backend is required to ship.

To wire it up properly, add an HTTPS Cloud Function (the `crm` codebase in
`../functions` already deploys to `europe-west3`) and set `partnerFormUrl`.

## npm note

npm 10.9.0 crashes resolving Nuxt's peer dependency graph:

```
TypeError: Cannot read properties of null (reading 'edgesOut')
  at #loadPeerSet (@npmcli/arborist/lib/arborist/build-ideal-tree.js)
```

`web/.npmrc` sets `legacy-peer-deps=true`, which avoids that code path. It
applies to `npm ci` in CI too, so both resolve identically. Remove it if npm is
upgraded past the bug.

## Still to do

- Replace placeholder domains and hosting site IDs
- Logo/wordmark (currently an amber dot + text)
- `og:image` and social cards
- Privacy page needs legal review before launch — it is marked `noindex`
- Analytics: none installed, deliberately (see the privacy page copy)
