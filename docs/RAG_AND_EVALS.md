# Factual agent, hybrid RAG, and evaluations

## What is implemented

The factual assistant is a bounded application loop around Gemini 3.5
Flash-Lite. It is not an unconstrained autonomous agent and has no write tools.

On each question:

1. the first Gemini turn must select one read-only tool;
2. tool names and arguments are validated by application code;
3. the application executes the tool against safe record projections;
4. Gemini may request additional tools;
5. the final response follows a structured schema; and
6. citation IDs are accepted only if an executed tool produced them in the
   current run.

Available tools:

| Tool | Purpose |
| --- | --- |
| `search_company_data` | Topics, names, phrases, and broad discovery |
| `get_company_record` | One complete safe record by known kind and ID |
| `list_company_records` | Exact relationships and filtered recent records |
| `aggregate_company_records` | Exact totals and supported groupings |

Calls, interactions, contacts, service requests, tasks, reviews, and audit
events are included. Credentials, access-control records, processing secrets,
raw storage paths, and unrestricted Firestore documents are not available to
the tools.

## Retrieval design

### Hosted default: Qdrant Cloud

Qdrant Cloud is the recommended hosted index for the spike because its current
free cluster provides 1 GB RAM, 4 GB disk, and no credit-card requirement. It
is sufficient for the current small corpus. The selected 1,536-dimensional
vectors use half the raw vector memory of the model's 3,072-dimensional
default while retaining more capacity than a 768-dimensional index.

The limitation matters: a free cluster is one non-HA node, is suspended after
one week without use, and can be deleted after four inactive weeks. It is a
prototype tier, not a production availability promise. See the official
[free-cluster documentation](https://qdrant.tech/documentation/cloud/create-cluster/).

### Dense representation

Documents and questions use `gemini-embedding-2` at 1,536 dimensions, one of
Google's recommended Matryoshka truncation sizes.
Embedding 2 does not accept the older `taskType` field. Documents are formatted
as `title: … | text: …`, while questions use
`task: search result | query: …`, following Google's asymmetric retrieval
guidance. Embedding 2 automatically normalizes the vectors. Its embedding
space is incompatible with `gemini-embedding-001`, so the migration uses the
versioned `company_context_v5` collection and re-embeds the entire corpus. See the
[Gemini embedding guide](https://ai.google.dev/gemini-api/docs/embeddings) and
[model page](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2).

### Lexical representation

Qdrant's server-side `qdrant/bm25` model supplies full-text ranking. It is
configured with language-neutral processing, multilingual tokenization, and
ASCII folding so Czech and English records can share one index. The same
settings are used at ingestion and query time. See Qdrant's
[full-text/BM25 documentation](https://qdrant.tech/documentation/search/text-search/full-text-search/).

### Dense-vector storage

Gemini returns each 1,536-dimensional embedding as floating-point values.
Qdrant converts and stores one `float16` representation. This halves raw dense
vector storage relative to `float32` and avoids retaining both an original
vector and a scalar-quantized copy. Dense prefetch searches that representation
directly before hybrid RRF; there is no quantized candidate search or rescoring
path.

Collection creation enforces:

```json
{
  "vectors": {
    "dense": {
      "size": 1536,
      "distance": "Cosine",
      "datatype": "float16"
    }
  }
}
```

The application does not round or cast Gemini embedding values itself. The
datatype is a collection-schema decision, so this migration builds the fresh
`company_context_v5` collection and cuts over only after retrieval verification.
See Qdrant's [vector datatype documentation](https://qdrant.tech/documentation/concepts/vectors/#vector-datatypes).

### Fusion and “weighting”

The initial ranking uses reciprocal-rank fusion with `k=60`. This is preferable
to a guessed raw-score blend because cosine and BM25 scores have incompatible
scales. Qdrant explicitly recommends RRF as the safe default when there is not
yet an evaluation set large enough to tune weights.

Once real labeled queries exist, the harness should compare:

- unweighted RRF;
- weighted RRF with dense/lexical weights learned on a training split;
- distribution-based score fusion; and
- optional reranking of the fused candidate set.

Weights must be selected on a training/validation split and reported on a held
out test split. They must not be chosen from a generic RAG blog post. See
Qdrant's [hybrid-query guidance](https://qdrant.tech/documentation/search/hybrid-queries/).

### Search availability

Production search requires Qdrant. A query that finds no matches stays empty;
it does not trigger a Firestore scan. If Qdrant is not configured, fails, or
does not answer within ten seconds, `search_company_data` returns a stable
temporary-unavailable result and the agent stops retrying search.

Exact record lookup, bounded filtered lists, and aggregate tools continue to
read Firestore because they express explicit, constrained queries. The
in-process BM25 implementation remains only for deterministic evaluation
fixtures; it is not a production fallback.

## Qdrant setup

Create one free Qdrant Cloud cluster and API key, then configure:

```text
QDRANT_URL=https://your-cluster...qdrant.io
QDRANT_API_KEY=...
```

Local development also accepts `QDRANT_CLUSTER_URL` as an alias for
`QDRANT_URL`. Deployments bind `QDRANT_URL` and `QDRANT_API_KEY` to the API
function through Secret Manager.

Never commit the key or expose it to the browser. Local development can read
these from `.env`. The Firebase API and synchronization trigger receive both
values through Secret Manager. The URL is not sensitive, but using the same
binding mechanism avoids an interactive runtime-parameter prompt in CI.

An application administrator can call `assistant.reindex` to replace only
their company's points in `company_context_v5` from safe Firestore records.
Every Qdrant operation is filtered by the server-resolved company ID; the
shared collection uses a tenant keyword index on that payload.

Normal index freshness is event-driven. A retry-enabled Firestore
`onDocumentWritten` trigger observes every direct company-data write in the
named `odorik` database and selects the allowlisted record collections. It
first creates or advances one deterministic `knowledgeIndexDeliveries` record,
then re-reads the current Firestore record, deletes every Qdrant chunk for that
record identity, and upserts the newly generated chunks. Deleting or disabling
a Firestore record removes its chunks. Re-reading the source makes retries
idempotent and prevents duplicate or out-of-order events from restoring an old
projection.

The trigger is eventually consistent, not part of the originating Firestore
transaction. A write can therefore be visible in Firestore briefly before its
new embedding is searchable. Delivery state has a generation-fenced 12-minute
lease, four bounded attempts with 1/5/30-minute backoff, stale-lease recovery,
terminal attention, and targeted administrator replay. Sources reports pending
and attention counts plus measured p95 context-to-search delay. A one-time
administrator backfill queues records that existed before durable delivery was
deployed. Those historical deliveries are excluded from freshness samples
because their original searchable time is unknowable; the next normal source
write restores measurement for that record. Provider-to-Firestore health
remains separate from this search delivery state.

The Gen-2 Firestore trigger is delivered by Eventarc to a private Cloud Run
service. Because this project uses the custom `odorik-crm` service account as
both the trigger delivery and runtime identity, the generated
`syncKnowledgeIndex` service grants that account `roles/run.invoker`. This is a
private service-to-service permission, not public invocation. The same
contract applies to `processCallWorkflows` and `projectCallContext`. Deployment
idempotently establishes the binding for all three services after Firebase
creates or updates them.

Operators can perform the same rebuild with application-default Google Cloud
credentials and receive a count/checksum/retrieval reconciliation report:

```bash
npm --prefix functions run qdrant:reindex
```

## Prompt-injection and data boundaries

- Retrieved text is explicitly labeled untrusted evidence.
- Only the application decides which tools exist.
- Tool inputs use strict Zod schemas and bounded limits.
- Firestore collections and fields are allowlisted.
- The model never receives credentials.
- The agent has no write tool.
- Unknown citation IDs are removed from the answer.
- Old conversation citation labels are stripped before reuse; every new answer
  must retrieve current evidence.
- Tool turns and final generation are bounded to prevent uncontrolled loops.

## Evaluation harness

The existing harness evaluates factual questions, not general conversation.
The first-turn `ANY` tool requirement is useful only when a turn is already
known to require company evidence. A Slack dogfood sequence on 2026-08-09–10
showed the failure outside that boundary: after a company-summary question, the
social turn “hello” was forced into another company-overview search and repeated
the summary. Conversation routing must therefore precede the factual loop.

Conversational evaluation is sequence-based rather than a bag of independent
questions. At minimum it must cover:

- greeting after a factual answer without tool use or repetition;
- pronoun and ellipsis resolution followed by fresh evidence retrieval;
- two rapid provider events processed in causal order;
- duplicate and out-of-order delivery;
- return after a session boundary;
- explicit correction, later recall, and deletion;
- source fact updates and source-access revocation between turns; and
- action requests becoming typed proposals rather than direct effects.

Store route, context revision, selected memory IDs, tool policy, tool trace,
answer, and delivery identity for each evaluated turn. Score response-mode
accuracy, retrieval/citation correctness, memory recall, appropriate
abstention, repetition, ordering, latency, and unauthorized recall separately.

Run deterministic unit and retrieval checks:

```bash
npm --prefix functions test
npm --prefix functions run eval
```

Run the real model against the versioned fixture corpus:

```bash
node --env-file=.env functions/lib/eval/run.js --live
```

The corpus is `functions/evals/fact-agent.json`. It currently covers:

- exact contact lookup;
- facts from a call;
- a multi-hop request-to-audit explanation;
- exact grouped counts; and
- an unanswerable financial question.

The offline run reports hit@5 and mean reciprocal rank for single-hop
retrieval. The live run checks expected answer terms, cited source paths,
confidence on abstention, and an aggregate pass-rate threshold.

### Next evaluation improvements

1. Save anonymized real questions and independently label relevant source
   chunks.
2. Separate train, validation, and held-out test cases before tuning fusion.
3. Add Czech morphology, phone numbers, names, dates, contradictions, and
   prompt-injection records.
4. Score retrieval recall separately from answer correctness and citation
   entailment.
5. Add a human-reviewed groundedness sample rather than relying only on an LLM
   judge.
6. Track cost, latency, tool count, abstention, and index freshness by prompt,
   model, embedding, and corpus version.
7. Make deployment fail when the held-out regression thresholds fall.
8. Add multi-turn and multi-session suites inspired by
   [LongMemEval](https://arxiv.org/abs/2410.10813)'s extraction, temporal
   reasoning, knowledge-update, and abstention categories; keep a smaller
   product-specific acceptance set as the release gate.
