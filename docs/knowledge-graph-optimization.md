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

## Protocol and accounting

`includeUsage: true` opts into:

```json
{
  "code": 200,
  "data": { "schemaVersion": 1, "nodes": [], "relations": [] },
  "usage": { "input": 100, "output": 40, "total": 140, "cachedInput": 80, "reasoning": 0 },
  "metrics": {
    "calls": 1, "completedCalls": 1, "queuedMs": 0, "generationMs": 50,
    "model": "deepseek-flash", "profile": "deepseek-graph-v2",
    "knownCalls": { "input": 1, "output": 1, "total": 1, "cachedInput": 1, "reasoning": 1 },
    "retryAfter": null
  }
}
```

Legacy requests retain their unwrapped response. Opted-in errors keep the HTTP
status and `detail` while also returning known accounting. Missing counters are
`null`; partial totals have per-counter known-call counts. Reasoning tokens are
already included in output tokens and are not added twice. Request outcomes with
missing accounting are counted separately as unknown. An incomplete call count also keeps generation
time from being presented as a known zero.

The internal graph wire format uses schema version 2, a shared quotation table
and integer citation indexes. The server restores source metadata and validates
the expanded public graph v1 contract. This changes representation, not graph
coverage or evidence requirements. Model-facing source text remains untrusted
user content; stable system instructions precede sources and dynamic corrections
follow them. No paid cache warm-up requests are sent.

The graph panel shows the last three of twenty locally saved processing reports:
initial processing, repeated processing and incremental updates. Each report
contains local result reuse, model calls, known token counters and timing. A
provider cache ratio is shown only when its input and cached counters are
complete. A partial subtotal is marked `≥`; unknown usage is never presented as
zero. An explicitly known zero-call repeat run has zero additional model usage.

## Rollout switches and phase two

| Desktop process setting | Default | Effect |
| --- | --- | --- |
| `LYNSE_GRAPH_SHOW_USAGE` | `1` | `0` hides the usage panel; accounting and model-profile verification remain active |
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

Offline fixtures exercise 30 sourced graph cases through both compact expansion
and conservative reuse, including uncertainty and verbatim evidence retention.
They validate the protocol; they do not measure live model accuracy or billing.
The loopback graph test covers the real HTTP route, Rust validation/storage and
desktop rendering using synthetic identity, authority and model responses.

Acceptance requires zero new model calls for identical completed input, reuse of
unchanged chunks after local edits, no invalid cross-language/scope hits, and
preservation of manual state. Record cold, repeated and incremental run metrics
separately. Compare live P50/P95 elapsed time, input/output tokens and cached input
ratios on the same authorized corpus before making performance claims or enabling
phase-two reuse. No fixed speed or token reduction percentage is assumed.
