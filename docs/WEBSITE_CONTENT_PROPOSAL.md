# Agent Erik — website content proposal

Status: **proposal for review**. No implementation yet.

Decisions taken: brand **Agent Erik**; **EN + CZ on two domains**; primary CTA
**design partner program**; structure **Landing + How it works** (plus legal).
No pricing page — pricing is a one-line mention only, and there is no
architecture/"under the hood" section.

---

## 1. Positioning foundation

### One-liner

> AI prepares the work. You make the call.

The double meaning is deliberate — phone calls are a primary input, and the
decision is yours.

### Elevator paragraph

Agent Erik turns what already happens at your company — calls, email, calendar,
documents — into concrete proposed actions, each carrying the evidence behind
it. You approve, refine by voice, or reject in seconds, from wherever you are.
Nothing consequential happens without a named human decision.

### The thesis the whole site argues

Enterprise AI stalls in pilots not because retrieval is bad, but because
**trust and execution friction** are unsolved. Retrieval quality is becoming
table stakes. What is not solved: getting a busy decision-maker to actually
review and authorize agent work, without chaining them to a desk.

So the site does **not** sell a RAG engine or a vector database. It sells a
**decision surface with accountability built in**.

### The "future of work" frame

This is the emotional core the user brief asked for, and it should carry the
hero and one dedicated section:

> Be on a beach, in a forest, between meetings. Your company keeps moving
> because the work arrives prepared and you stay in the loop with your thumb
> and your voice — not with a laptop and twelve browser tabs.

Freedom of location, without giving up control or accountability.

### Vocabulary rules

**Use:** proposal · decision · evidence · accountability · approve · refine ·
prepare the work · stay in the loop · steer · named owner · reversible ·
audit trail

**Never use on the site:**

- "Tinder" or any dating-app metaphor — internal slang only.
- "Autonomous" / "acts on your behalf" — contradicts the product's core promise
  and `PRODUCT_VISION.md:107-120`.
- "AI employee", "replaces your team", "fires your ops manager".
- "Google ADK" — not in the stack.
- Any claim that a feature is live today when it is not (see §6).

**Handle "swipe" carefully.** `PRODUCT_VISION.md:16-20` is explicit that the
gesture is not the product and must never be the only way to decide. Keep it
out of headlines. It may appear once, low on the How it works page, as *"a
thumb gesture accelerates a decision; buttons and screen readers do the same
job"* — which turns a gimmick into an accessibility proof point.

---

## 2. Site map

| Route (EN) | Route (CZ) | Purpose |
| --- | --- | --- |
| `/` | `/` | Full narrative: problem → product → proof → CTA |
| `/how-it-works` | `/jak-to-funguje` | Mechanism, governance, trust |
| `/privacy` | `/soukromi` | Legal (mirrors headstart) |

Global: sticky nav, footer, and one recurring design-partner CTA band.

---

## 3. Landing page (`/`)

### 3.1 Hero

**H1:** AI prepares the work. You make the call.

**Sub:** Agent Erik turns your calls, email, and calendar into concrete proposed
actions — each with its evidence attached. Approve, refine by voice, or reject
in seconds, from wherever you are. Nothing consequential happens without your
decision.

**Primary CTA:** Become a design partner
**Secondary CTA:** See how it works →

**Visual:** a phone mockup showing a single decision card mid-screen. Not a
dashboard. The card shows: proposed action, the trigger that caused it, two
bullets of evidence, and Approve / Refine / Reject controls. This image is the
product's entire argument in one frame — it deserves real design effort.

**Trust strip under the fold:** "Built on Google Cloud · Data stays in
europe-west3 · Every decision is auditable"

### 3.2 The problem

**H2:** Most AI pilots die in the gap between a good answer and a real action.

**Body:** Your agent can retrieve the right context and draft the right
follow-up. Then it stops — because nobody sane lets software change a customer
record, send a quote, or book a commitment on its own. So the work queues up
behind whoever has time to open a dashboard. The bottleneck was never the
model. It was the review.

**Three friction points** (icon + one line each):

1. **Nobody wants another desktop chat window.** Leaders don't work at a desk.
2. **Dashboards are where decisions go to wait.** Reviewing costs more than the
   task saved.
3. **Nobody will accept silent AI writes.** And they shouldn't.

### 3.3 The shift

**H2:** Turn oversight from a desk chore into a five-second habit.

**Body:** Agent Erik collapses every agent execution decision into one card you
can act on with a thumb. The work is already prepared and sourced. Your job is
the part only you can do: decide.

**Three-step visual** (the pipeline from the brief, rendered as three columns):

| Capture | Prepare | Decide |
| --- | --- | --- |
| Phone calls, recordings, email, calendar, documents | Retrieval across your company context, then a typed proposal with cited evidence | Approve → it executes. Refine by voice → it re-runs. Reject → it closes. |

### 3.4 What makes it different

Table adapted from the USP analysis — strongest single asset on the page.

| | Standard enterprise AI | Agent Erik |
| --- | --- | --- |
| **What you get** | A text answer or a search summary | A pending action, ready to authorize |
| **What goes in** | PDFs, docs, chat messages | Phone calls and audio — real operational intent, captured before anyone writes it down |
| **How humans stay in control** | A web dashboard someone opens eventually | A mobile decision card and a voice reply, in seconds |
| **How you pay** | Per seat, per month | Usage-based. Approvers cost nothing to add |

Framing line beneath: **Passive search becomes an active execution pipeline —
with a person on the authorizing end of it.**

### 3.5 Anywhere (the "future of work" section)

**H2:** Stay in the loop without staying at your desk.

**Body:** The work doesn't wait for you to get back to a laptop, and you don't
have to pretend to be available to keep things moving. Proposals arrive when
they're ready. You handle them from a trailhead, a departure lounge, or
between two meetings — with your thumb, your voice, and your judgment. That's
the part of your job that doesn't delegate. Everything before it does.

**Supporting detail — the voice loop:** Reject something and just say why:
*"Price this at 12k, not 10."* Erik takes the correction, re-runs the work, and
comes back with a revised proposal. No form, no typing, no context switch.

### 3.6 Accountability

**H2:** Every decision has a name on it.

**Body:** An approval here isn't a flag in a database. It records who decided,
exactly which version of the proposal they saw, what effects they authorized,
and when. Agents read and prepare freely. Changing your business — or touching
an outside system — takes one explicit human decision, every time.

**Four proof points:**

- **Evidence, not vibes.** Every proposal cites the source items it used.
- **No dark approvals.** Consequential actions never hide behind a generic
  "continue."
- **Versioned proposals.** Request a change and you get a new immutable
  version, not a quietly edited one.
- **Reversibility is disclosed.** The card tells you whether it can be undone.

### 3.7 Where it starts

**H2:** Built first for teams that live on the phone.

**Body:** Agent Erik began inside a working phone system, where every completed
call becomes governed company context: summarized, classified, quality-checked,
routed, and turned into proposed follow-ups. Call centres and sales teams are
where the value shows up fastest — but nothing in the platform assumes a phone
call or a fixed CRM schema.

### 3.8 Closing CTA

**H2:** We're taking on a small number of design partners.

**Body:** We're building this with a handful of companies who run real
operational load through it and tell us where it breaks. You get direct
influence over the product and pricing that reflects the risk of going early.

**Pricing line (the only pricing statement on the site):** Pricing is
usage-based, never per seat — every approver you want in the loop costs
nothing to add.

**Form fields:** name · work email · company · what your team runs on today
(calls / email / field ops / other) · optional message

---

## 4. How it works (`/how-it-works`)

Written for the technical evaluator who has to approve the purchase.

**H1:** How Agent Erik works

**Intro:** Three ideas do the work: everything that enters keeps its
provenance; agents propose but never execute; and a person authorizes one
specific version of one specific proposal.

### 4.1 The six loops

Adapted from `PRODUCT_VISION.md:41-105`, one short section each:

1. **Ingest** — Connectors pull in calls, calendars, documents, and messages.
   Every item keeps its source, timestamps, permissions, and original identity.
   Nothing is flattened into untraceable model memory.
2. **Converse** — Ask, explain, delegate in a thread with shared company
   context. The thread is working context, not authoritative state.
3. **Propose** — The agent produces a typed proposal: what it recommends, why,
   the evidence used, what's unknown, exactly what would change, and whether
   it's reversible.
4. **Decide** — Approve · Reject · Request changes · Edit and approve.
5. **Execute** — Only application-owned handlers change real state. They
   recheck membership, permissions, proposal version, preconditions, and
   idempotency first.
6. **Learn** — Approval and rejection patterns improve the system without
   quietly widening any agent's authority.

### 4.2 The responsibility boundary

Reproduce the table from `PRODUCT_VISION.md:111-115` almost verbatim — it is
unusually clear and is a genuine differentiator in a market full of hand-waving:

| Write | Automatic? | Authority |
| --- | --- | --- |
| Source observations (a received call, a synced event) | Yes | The connector and original source |
| Derived state (transcripts, indexes, summaries, drafts) | Yes | Non-authoritative, with provenance |
| Business mutations and external effects | **No** | One explicit human decision |

### 4.3 Anatomy of a decision card

Walk through a real example against the three-second scannability rule:

- **Proposed action** — "Schedule follow-up with ACME Corp and draft a
  preliminary quote."
- **Trigger** — "From today's 14:00 call with John Novák."
- **Evidence** — two bullets, each traceable to a source item.
- **Consequence** — which systems change, and whether it's reversible.
- **Controls** — Approve · Refine (voice) · Reject. Gestures accelerate;
  buttons and screen readers do the same job. Decisions are never
  gesture-only.

### 4.4 Connectors

Read and action capabilities are granted separately — letting Erik read your
calendar never implies permission to create an event. Live today: phone calls
and recordings, Google Calendar, Google Drive. Email and messaging next.

**CTA band.**

---

## 5. Shared elements

**Nav:** Logo · How it works · [Become a design partner] · EN/CZ

**Footer:** short product line · Privacy · contact email · company details ·
"Built in Prague" (if accurate)

**Recurring CTA band** at the bottom of every page: *"Running real operational
load and want to shape this? We're taking design partners."*

**Design direction:** dark, calm, high-contrast. One accent color. The phone
card is the hero asset. Avoid the AI-startup cliché kit — no neural-net
gradients, no glowing brains, no robot faces. Show the card, the evidence, and
a person's thumb. Restraint reads as trustworthy, which is the entire pitch.

---

## 6. Claims to verify before launch

The site must not describe unbuilt things in present tense. Current reality per
`docs/IMPLEMENTATION_SLICES.md`:

| Claim | Status | Handling |
| --- | --- | --- |
| Call ingestion + transcription | **Built** | Safe to state plainly |
| Calendar + Drive connectors | **Built / in progress** | Safe |
| Hybrid retrieval, cited evidence | **Built** | Safe |
| Decision cards / approval loop | **Not built** (Slice 4) | Design-partner tense |
| Voice refinement loop | **Not built** | Design-partner tense |
| Push notifications | **Not built** | Design-partner tense |
| Executing external write actions | **Not built** (Slice 5/6) | Design-partner tense |

Recommended device: a short, confident line near the CTA — *"Erik is in active
development with our first design partners. Call ingestion, retrieval, and
evidence are working today; the decision and execution loop is what we're
building next — with you."* Honesty here is a sales asset, not a liability.
Buyers in this category have been burned by demo-ware.

---

## 7. Implementation notes

Mirrors `../appheadstart/web` deliberately.

**Location:** `web/` alongside `frontend/`, with its own `package.json`,
`nuxt.config.ts`, and `firebase.json` — same isolation headstart uses.

**Stack:** Nuxt 4 static (`nitro.preset: 'static'`), Tailwind, `@nuxtjs/i18n`
(`strategy: 'no_prefix'`), `@nuxt/image` (webp, q80), Node 22.

**Locale build matrix** — copy headstart exactly: `DEFAULT_LOCALE` env drives
`nitro.output.dir` = `.output-${locale}`, CI runs `nuxi generate` twice, each
output maps to its own hosting site.

**Two open items to settle at implementation time:**

1. **Domains and hosting site IDs.** Headstart uses `headstart.cz` /
   `joinheadstart.com`. Erik needs an equivalent pair (e.g. `agenterik.cz` and
   `agenterik.com`) plus two Firebase hosting site IDs.
2. **Root `firebase.json` conflict.** The repo's current `firebase.json:10-33`
   declares hosting as a **single object** with no `site` key, serving the app
   from `frontend/dist`. Adding marketing sites to the same Firebase project
   means that object must become an **array** and the existing app entry must
   gain an explicit `site` key — otherwise deploys become ambiguous and the app
   site is at risk. Cleanest path: give `web/` its own `firebase.json` with its
   own hosting array, deploy via GitHub Actions `entryPoint: web`, and add the
   `site` key to the root config in the same change.

**CI:** new `.github/workflows/deploy-web.yml` modeled on headstart's — path
filter on `web/**`, `npm ci`, two locale builds, `FirebaseExtended/action-hosting-deploy@v0`
with `entryPoint: web`, `channelId: live`.

**Dynamic bits (client-only, no SSR):** the design-partner form. Either a
callable Cloud Function in the existing `crm` codebase or a new small one, same
shape as headstart's `sendBrief`. Route rule `{ ssr: false }` if it becomes its
own page; inline modal otherwise (headstart's `BriefModal.vue` is directly
reusable as a pattern).

---

## 8. Czech headline pass

The Czech is a **parallel native version, not a translation.** The English hero
leans on the "make the call" pun; Czech can't carry it, so it leans on
*poslední slovo* instead. Where an English image doesn't exist in Czech, the
Czech says the thing plainly rather than importing the metaphor.

- **H1:** AI odvede práci. Poslední slovo máte vy.
- **Sub:** Agent Erik prochází hovory, e-maily a kalendář a chystá konkrétní
  návrhy — ke každému rovnou podklady, ze kterých vychází. Schválíte,
  zamítnete, nebo hlasem řeknete, co změnit. Za pár vteřin, ať jste kdekoli.
  Bez vašeho souhlasu se nestane nic.
- **Problem:** Většina firemních AI projektů uvízne na půl cesty. Odpověď
  máte, ale nikdo s ní nic neudělá.
- **Shift:** Schválení zabere pět vteřin v mobilu, ne půl hodiny u počítače.
- **Anywhere:** Firma jede dál, i když zrovna nesedíte u počítače.
- **Accountability:** Za každým rozhodnutím je podepsaný konkrétní člověk.
- **Pricing mention:** Neplatíte za licence, ale za to, co skutečně využijete.
  Přidat dalšího člověka, který schvaluje, nic nestojí.
- **CTA:** Staňte se pilotním partnerem

**Notes for the translator / implementation:**

- Avoid **„AI pilot"** as a noun — in Czech a *pilot* flies a plane. Use
  *pilotní projekt* / *pilotní partner*.
- Avoid **„schvalovatel"** — nobody says it. Rephrase as *člověk, který
  schvaluje*.
- Avoid **„akce"** for actions — *návrh* or *co udělat* reads far better.
- The EN term *design partner* stays English in EN copy; CZ uses *pilotní
  partner*. Don't mix the two on one page.

---

## 9. Open questions

1. Domains — confirm the pair, and who holds the DNS.
2. Is "Built in Prague" accurate and do you want it public?
3. Do team profiles belong on this site, or stay on headstart-style pages?
4. Logo and brand color for Erik — reuse something existing, or new?
5. Analytics — any, and which? (Affects the privacy page.)
6. Does the design-partner form write to Firestore, send email, or both?
