# Decision Record: Batch cold native-derived tree removal

Status: implemented

## Problem

Historical attachment metadata and native field preparation remove one derived subtree for every pending canonical Part. Their original migration pages already share one transaction, but each removal repeats artifact collection-intent, reference, record and node operations. That dispatch cost grows with every historical producer, including producers whose derived tree is empty. A node-only emptiness check cannot replace artifact cleanup because references can exist independently of those nodes.

## Decision

The Store owns an explicit bounded `removeTrees` array operation, with the same key codec, artifact-prefix builder, transaction and backend as its single-tree operation. It validates all input selectors before admission and group-guard effects. Exact artifact ranges retain durable collection intents and delete references independently of node existence. A materialized recursive union tombstones each selected live record once, removes that same node set and invokes existing addressed ancestor cleanup. Duplicate and overlapping selectors do not multiply a tombstone's revision. The original single-prefix operation remains unchanged.

The two Session owners use this operation only for pending roots in each existing cold migration page. The original page transaction clears that set, then reads and decodes one current canonical Part at a time, validates address and revision and publishes through the same private projection writer used by ordinary capture. It does not retain a page of complete bodies. Ordinary capture retains its original single-tree removal and canonical-read phases; there is no skip-clear switch or alternate decoder.

Separate migration identities, dependency order, receipts, unknown-header rejection, display/search maintenance, cancellation and page rollback remain. Field chunks are ordinary records; immutable artifact and checkpoint references retain their original owners and exact source/version validation. Later writes still perform their own current admission, deleted-Session and mutation checks. The change introduces neither an authority cache nor a persisted format, driver protocol, ordinary-append batch or longer deadline.

## Alternatives considered

**Retain one tree-removal operation per Part.** The page transaction does not combine the repeated engine dispatches, even when all selectors are already known and admitted by the same owner.

**Skip cleanup when derived nodes are absent.** Artifact references are independently indexed; this would omit collection intent or leave an old reference outside the node tree.

**Combine the migrations or prepopulate their receipts.** Their dependencies and owner preparation remain distinct. Skipping a later migration would replace current producer evidence with an assumption about earlier work.

**Retain a page of canonical bodies or batch ordinary producer facts.** Cold migration knows its bounded selector set, but original producer capture and immutable-field publication keep their own ordering and memory limits. Extending batching to those paths would require separate evidence and controls.

## Consequences

The new array operation deliberately groups removal admission and guards and clears the pending set before serial publication. It does not promise the intermediate callback order of separate single-tree calls. Every later write still validates current state, and any failure rolls back its original page while earlier completed pages remain committed. Unknown projection versions remain errors; retry rechecks current headers and canonical revisions.

Artifact ranges must remain addressed indexed work on the actual backend. Reusing the original range builder is insufficient evidence if an OR plan degrades into a namespace scan. The Store controls inspect the actual SQLite statement plan alongside namespace, segment, orphan-reference, retained-pack, revision and rollback behavior. Owner controls retain malformed suffix and changed-revision interleavings. The new Store cases belong to the existing shared PostgreSQL contract inventory. Executed results and remaining validation belong to the [incident record](../../../postmortem/0219-cold-derived-pages-repeated-tree-cleanup.md).

The PostgreSQL control uses the exact original GC and delete statements and parameters under rolled-back diagnostic savepoints before forwarding each ordinary operation. With the ordinary planner, it accepts owner-index filtering bounded by the selected Session owner and rejects a real namespace-only scan against thousands of unrelated references. It does not require the SQLite per-prefix seek shape or force planner settings. Index scan candidate counters and heap visits remain separate observations. See the PostgreSQL [EXPLAIN contract](https://www.postgresql.org/docs/17/using-explain.html) and [index combination behavior](https://www.postgresql.org/docs/17/indexes-bitmap-scans.html).

Reduced native dispatch is a local work bound, not measured CI speed or complete capacity acceptance. Ordinary native append is unchanged.

## Related

- [Native field sources](../architecture/2026-11-12-read-native-fields-from-producer-derived-sources.md)
- [Attachment metadata](../architecture/2026-11-12-page-tool-attachments-by-canonical-producer-revision.md)
- [Agent Storage](../../../architecture/agent-storage.md#records-and-transactions)
