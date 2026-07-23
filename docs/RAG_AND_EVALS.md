# Factual agent, hybrid RAG, and evaluations

## What is implemented

The factual assistant is a bounded application loop around Gemini 3.1
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
supports about one million 768-dimensional vectors according to its published
estimate, which is more than enough for early call and document chunks.

The limitation matters: a free cluster is one non-HA node, is suspended after
one week without use, and can be deleted after four inactive weeks. It is a
prototype tier, not a production availability promise. See the official
[free-cluster documentation](https://qdrant.tech/documentation/cloud/create-cluster/).

### Dense representation

Documents use `gemini-embedding-001` with `RETRIEVAL_DOCUMENT`; questions use
`QUESTION_ANSWERING`. Embeddings are reduced to 768 dimensions. Google lists
the text embedding model on both free and paid Gemini API tiers. See the
[Gemini embedding guide](https://ai.google.dev/gemini-api/docs/embeddings) and
[pricing](https://ai.google.dev/gemini-api/docs/pricing).

### Lexical representation

Qdrant's server-side `qdrant/bm25` model supplies full-text ranking. It is
configured with language-neutral processing, multilingual tokenization, and
ASCII folding so Czech and English records can share one index. The same
settings are used at ingestion and query time. See Qdrant's
[full-text/BM25 documentation](https://qdrant.tech/documentation/search/text-search/full-text-search/).

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

### Fallback

If Qdrant is not configured or a query fails, the agent uses an in-process BM25
ranking over allowlisted Firestore projections. This keeps the product usable
during setup and free-cluster suspension. It does not provide semantic recall
and rereads a bounded corpus, so it must not be mistaken for the production
large-corpus design.

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
these from `.env`. For the current Firebase deployment, bind both values from
Secret Manager only to the `api` function. The URL is not sensitive, but using
the same binding mechanism avoids an interactive runtime-parameter prompt in
CI. Until those bindings are deliberately added, deployed code reports and
uses `firestore_lexical_fallback`.

An application administrator can call `assistant.reindex` to create a fresh
`company_context_v1` collection and rebuild it from safe Firestore records.
The rebuild deliberately replaces the collection so stale chunks cannot
survive. Incremental indexing is Slice 2.

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
