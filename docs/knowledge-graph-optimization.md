# Knowledge graph processing and cache contract

Graph extraction uses the server-owned DeepSeek official `deepseek-flash` model
at `https://api.deepseek.com/responses`, with thinking disabled and a 16,000-token
output ceiling. Configure `DEEPSEEK_API_KEY` on the Lynclaw service. Graph calls
never inherit a chat model's endpoint or credential; other synthesis tasks keep
their existing model selection. Chat model changes use the dedicated
`workbench_set_text_model` bridge command without rebinding the account or
cancelling graph work. Text-only synthesis detects a changed model and resumes
under the new setting; account, server, language and consent lifecycle changes
still cancel their corresponding work.

Deploy the Lynclaw protocol before updating desktop clients. The desktop checks
the returned `deepseek-graph-v2` profile and model identity before accepting a new
result. An older service without this confirmation produces an actionable update
error rather than an incorrectly attributed cache entry. Existing legacy graph
results remain readable and are not automatically rebuilt.

## Result cache and identities

- Cache addresses include account scope, source, actual masked model input,
  title, language, model/provider, protocol/schema/masking versions and wire
  format. They exclude chat settings, API keys, folder IDs and source revision
  metadata. A prompt or privacy-rule change must bump the protocol or masking
  version in both repositories.
- The saved layout preserves unchanged chunks as ordered anchors when text is
  edited or inserted. Only gaps are repartitioned, at 12,000 characters maximum.
  Identical chunks within the same source share one result. Valid empty graphs
  are cached too.
- Cached quotations are masked again, validated against current source text and
  restored to current local originals. They are rebound to the current revision;
  source authorization is still checked before any remote model use.
- Result addresses are independent of graph identities. Legacy chunk identities
  stay intact. On an explicit refresh, unambiguous matching sourced claims retain
  their node/relation identities despite model key or relation order changes.
  Unmatched claims get new identities rather than inheriting another claim's
  manual review. Old reviews, merges and todo mappings are not deleted.
- Results with unknown legacy model provenance remain legacy. The explicit
  "Process legacy results with DeepSeek" action refreshes them using the fixed
  model; it does not relabel old results as verified DeepSeek output.

## Scheduling and failures

The graph worker runs up to three different chunks concurrently. Wiki and graph
calls share a three-slot model queue, and graph batches have one execution gate
per application state. Durable claims keep duplicate runners from submitting
the same chunk again.

`429` responses reduce new work to a serial recovery queue, honor numeric or
HTTP-date `Retry-After`, and allow at most one graph retry. Provider SDK retries
are disabled. A structural validation error permits one correction; truncated
output is a separate failure. Network timeouts and interrupted work remain
explicit unknown outcomes until the user requests a retry. Completed chunks are
committed individually and survive interruption.

## Protocol and model provenance

The desktop requests `includeGraphProfile: true` to verify model provenance:

```json
{
  "code": 200,
  "data": { "schemaVersion": 1, "nodes": [], "relations": [] },
  "graphProfile": { "model": "deepseek-flash", "profile": "deepseek-graph-v2" }
}
```

Graph usage collection, counters, processing reports and their UI have been
removed. Older local tracking files remain readable; obsolete accounting fields
are ignored and omitted on the next save without altering cached results or
manual reviews, merges and todo links. The desktop also accepts provenance from
an older service's `metrics` object and ignores any accompanying accounting.

Requests without an envelope option retain their unwrapped response. The legacy
`includeUsage` option is accepted for older clients but returns only model,
profile and retry control metadata; it does not enable usage collection. New
clients use `graphProfile`, and rate-limit delays remain in `Retry-After` headers.
To remain compatible with the deployed previous service, the desktop also sends
the legacy envelope option. Updated services prioritize `graphProfile`; older
services return provenance under `metrics`. The desktop discards their usage
counters, so compatibility needs no extra model call or local usage collection.

The internal graph wire format uses schema version 2, a shared quotation table
and integer citation indexes. The server restores source metadata and validates
the expanded public graph v1 contract. This changes representation, not graph
coverage or evidence requirements. Model-facing source text remains untrusted
user content; stable system instructions precede sources and dynamic corrections
follow them. No paid cache warm-up requests are sent.

## Rollout switches and phase two

| Desktop process setting | Default | Effect |
| --- | --- | --- |
| `LYNSE_GRAPH_CONTENT_CACHE` | `1` | `0` falls back to whole-document invalidation and fresh fixed-size boundaries |
| `LYNSE_GRAPH_COMPACT_OUTPUT` | `1` | `0` requests the legacy citation representation with JSON output |
| `LYNSE_GRAPH_CONCURRENCY` | `3` | Clamp between 1 and 3; use `1` for serial graph processing |
| `LYNSE_GRAPH_REUSE_FACTS` | `0` | Enable conservative reuse of graph evidence for automatic Wiki source analysis |

For direct clients that omit `compactGraph`, the Lynclaw environment variable
`LYNCLAW_GRAPH_COMPACT_OUTPUT=0` defaults to the legacy wire representation.

Phase-two reuse is implemented but remains off pending real-model quality
comparison. It requires current fixed-model output, the current language and
source authority, and exact quotation coverage of every non-whitespace source
character. Missing, legacy, failed or partial graph evidence falls back to the
existing topic-specific model analysis. Original bounded source text always
remains in the compilation request, and generated graph facts are not treated
as independent source corroboration. Topic generation keeps its existing model.

## Validation and performance measurement

Wiki organization retries preserve successful catalog receipts and completed pages.
Its text identity includes the protocol, input format, language and model selection;
changing only the API gateway does not invalidate completed work. Legacy receipts
are adopted only when their complete prior input identity and current citations
validate. Failed source analysis preserves existing topic associations, and topics
with unavailable inputs keep their saved pages instead of compiling partial content.

Automatic Wiki page and compilation identities use the topic's actual source
inputs, instructions, language and model. Extending, shrinking or reordering the
global folder selection does not invalidate a topic whose selected inputs are
unchanged. Authorization is still checked before cached evidence is reused.
Legacy scoped page identities are upgraded locally only after an exact prior
input-hash match and current quotation/content validation. This migration is
bounded, makes no model requests and preserves page IDs, reviews and Markdown;
unverifiable legacy results remain untouched. Pausing automatic organization
continues to preserve both these caches and ordinary local synchronization.

Organization checks the selected server's current knowledge policy before model
work. Missing enrollment or a changed folder range is reported as a setup failure;
identity and service failures stop the run until retry instead of failing every
chunk in sequence. Source failures retain the source, processing stage, time and
technical cause, with links to the relevant settings or original source. Failed
runs do not show a successful 100-percent progress indicator.

Offline fixtures exercise 30 sourced graph cases through both compact expansion
and conservative reuse, including uncertainty and verbatim evidence retention.
They validate the protocol; they do not measure live model accuracy or billing.
The loopback graph test covers the real HTTP route, Rust validation/storage and
desktop rendering using synthetic identity, authority and model responses.

Acceptance requires zero new model calls for identical completed input, reuse of
unchanged chunks after local edits, no invalid cross-language/scope hits, and
preservation of manual state. Use separate development benchmarks on an authorized
corpus before making performance claims or enabling phase-two reuse. No fixed speed or token reduction percentage is assumed.
