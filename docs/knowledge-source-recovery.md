# Knowledge source persistence and recovery

## Commit boundary

Source updates prepare an account-scoped `<source-hash>.write.json` journal before changing either the structured source or its Markdown view. The journal contains the target source, target entry, exact Markdown, and prior revision/Markdown hash. Existing manifest files require no destructive migration.

At the next source sync, recovery runs before source discovery or network calls:

1. Finish cleanup for durable source tombstones.
2. Replay incomplete source journals against the last manifest checkpoint.
3. Preserve external Markdown edits as conflicts and stage the incoming source pair.
4. Remove a journal once the manifest and source files acknowledge its target. Replaying a recovered journal after another interruption is idempotent.

The source directory, journal names and embedded source IDs are verified before replay. A damaged journal is preserved and reported as an error rather than guessed or overwritten. An unexpected structured-source snapshot is archived before replacement. Recovery does not run on other accounts' source directories.

## User edits and conflict resolution

A Markdown file with no registered entry is treated as a potential user edit. Downloading the same source ID cannot silently replace differing contents. Existing conflicts without an incoming pair can reconstruct that pair from the last validated structured source, allowing offline resolution; a forced cloud refresh can obtain a newer incoming version.

Choosing local content preserves the exact Markdown bytes and records the accepted incoming revision. Choosing incoming content first archives the local Markdown, structured source and incoming pair. Resolution uses the same recoverable commit protocol as ordinary source updates.

User-edited, previously accepted or conflicting files withdrawn from the source list are archived under `Meetings/<account>/.source-archive/<source-hash>/<archive-id>/`. Each archive includes its source identity, reason and timestamp. These archives are outside source discovery and AI indexing. Generated source copies without local edits can be removed directly.

## Durable withdrawal

`Manifest.sourceTombstones` defaults to an empty map for older accounts:

- `removed:` records an explicit deletion. Account runtime invalidation rejects in-flight work and later source commits cannot recreate that ID.
- `absent:` records absence from a verified cloud enumeration. A later complete enumeration that explicitly returns the source may restore it; previously archived user edits remain available in the archive.
- `private:` records withdrawal for private/encrypted inspirations. Cleanup removes source copies, incoming files, journals, local backups and source archives instead of creating a new plaintext archive.

Tombstones are persisted before deleting files. Interrupted cleanup is resumed on the next source recovery pass. There is no automatic restoration of explicitly deleted IDs.

`Manifest.wikiRevision` is also backward-compatible with an empty default and is independent of source recovery.

## Source refresh identity

The remote source revision includes stable source metadata and explicit revision fields. Server read counters, signed URLs and UI selection flags are excluded. Tags and related todos are sorted before hashing. Actual source timestamps, title, folder, status, permissions and meaningful todo changes still invalidate the remote snapshot. Upgrading from the previous raw-response hash may cause one source detail refresh; downstream AI content identity determines whether model work is needed.

Source sync completion preserves the progress phase of an independently running Wiki task.

## Validation fixtures

`source_recovery_tests.rs` covers interruption after journal preparation, after source write, after Markdown write and after manifest persistence; external edits during recovery; legacy conflicts without incoming files; unregistered Markdown; durable deletion; and private plaintext cleanup. All fixtures use temporary directories.

`source_sync_safety_tests.rs` checks that counter/URL/order changes keep the remote revision stable, real updates change it, and source completion preserves active Wiki progress. No test modifies the user's knowledge base or calls a model.
