# Broad topics and internal issues

The knowledge browser now presents two levels: broad parent topics and the existing specific issues inside them. A parent aggregates multiple original meeting references, while each issue keeps its ID, source quotations, reviewed page, corrections and revision history.

## Classification

- A dedicated `wiki_topic_group` task classifies existing topic titles and validated overviews. Original meeting transcripts are not sent for classification; only short topic metadata and authorization descriptors are used.
- Requests contain at most 30 issue labels, 20 source descriptors and a bounded existing-parent context. The client checks authorization for every underlying source, including sources beyond the descriptor subset.
- The normalized result accounts for every input issue exactly once, either under a parent or in the explicit unassigned list. Repeated identical assignments coalesce. Missing, conflicting or unknown-parent assignments and single-issue new groups remain unassigned, without inventing IDs or changing evidence. An unreadable result allows one bounded correction using a safe rule code; invalid model text is never replayed as instructions.
- Existing parent titles remain user-owned. Classification expresses navigation relatedness; it does not merge people or projects, resolve contradictions or establish factual relationships.
- Successful classification persists a per-topic input version and durable work receipt. Unchanged completed topics require no new model call. Manual assignments and removals override automatic classification.
- In-flight topics are persisted as blocked work. A restart or unknown outcome requires an explicit retry; a changed batch context cannot silently resubmit those topics.
- Graph extraction, source analysis, ordinary topic compilation and their existing caches are retained. Grouping does not require re-extracting those results.

## Manual grouping

Use **Group topics / 合并专题** near the top of the knowledge page. Choose issues, then select an existing parent or create a new one. A selection can contain issues from different meetings. This operation is local and works while AI organization is paused.

Open a parent to read its issues, source meetings and timeline. **Remove from this topic / 从本专题移出** keeps the issue and its evidence available. The issue page links back to its parent. Membership changes are backed up under `topic-group-actions/`; original issue pages are not rewritten.

The directory and graph display parents first. Unassigned issues remain in a separate expandable directory section and in full-topic search. Internal issues remain searchable and directly accessible. Graph connections are derived from the original shared-source edges, with internal edges collapsed inside their parent.

## Validation and rollout

- Native Workbench: 170 passed, 5 ignored; includes preservation of reviewed pages, multi-meeting source counts, source exclusion, regrouping/removal, output coverage and result-cache behavior.
- Views: 730 passed, 1 skipped; TypeScript check passed.
- Desktop browser flows: 10 passed, including local grouping while paused and preservation of original issue history. The final toolbar placement was rechecked with the two grouping flows.
- Backend: 52 grouping, synthesis compatibility, catalog, citation and graph tests passed, including conservative normalization and bounded correction.
- Test API `lynclaw-api-006` runs image `lynclaw-api:fc329950`, source snapshot `b5c1a81d2322bf5787c2b34abd1786085ad603af` (including conservative navigation normalization). Health and authentication smoke checks passed 5/5, with service configuration and environment keys unchanged. The memory service remains on its existing deployment.
- Native package remains version 1.2.2, local build 1030.1.3, using the unified official login surface and the existing test-server account.

The first classification run consumes model requests for metadata grouping. Subsequent runs reuse unchanged classification results. Failed original-source citation validation remains visible and is not accepted as successful output.


Live validation found broad parents spanning multiple meetings: the product-development parent grew from 20 issues across 9 meetings to 43 issues across 23 meetings. All 652 original topic IDs and the current or historical revisions of all 639 originally published pages remain present. The 340 original catalog chunk-cache entries, 716 identities and cached detail entry remain present. Classification failures are separate from original meeting citation validation failures.

After deploying conservative normalization to the test API, three consecutive live batches completed (90 additional issues) with no classification errors. The snapshot contained 14 parents and 236 processed issues; the remaining initial classification continues in the background. The product-development parent displayed 53 issues across 27 meetings during the native UI check.
