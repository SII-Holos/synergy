# Decision Record: Reject cyclic native binding ancestry

Status: implemented

## Problem

Native binding resolves Cortex parents through current canonical index/Info pairs before returning the aggregate root. Its visited-set condition tested the return value of `Set.add()`, which is always the Set itself. A historical two-Session parent cycle can satisfy both local parent/index and Cortex-parent checks while repeatedly reading the same pairs without terminating.

Public Session creation requires an existing parent and its established parent identity is immutable. These API checks do not make a reader safe against previously persisted corruption installed through trusted migration or restoration paths; this change does not claim that a generic bulk prewrite guard validates arbitrary proposed graphs. Local pair consistency is insufficient evidence of an acyclic ancestry graph.

## Decision

Test visited membership before adding each currently loaded Session. A repeated identity returns no native binding. Keep all fresh canonical reads and the existing Scope, organization, creator, driver, epoch and Cortex-parent comparisons. No timer, parent-count quota, cached authority or alternate reader is introduced.

## Validation

The existing native-binding fixture installs two complete, schema-valid cyclic pairs atomically through the real Store's trusted migration context, then confirms their individual Core and dynamic Session metadata checks succeed. Ordinary binding and creation-time mutation binding must both return undefined after the two nodes and their closing edge. A pass-through observer rejects a fourth canonical pair read, forcing the original loop to settle as a behavioral failure without a framework timeout, escaped asynchronous work or replacement metadata. The observer is restored only after the original operation settles; the original acyclic records are then restored and resolve normally.

## Alternatives considered

**Trust each canonical pair independently.** Both pairs can be individually valid while their combined ancestry is cyclic.

**Use a deadline or fixed depth limit.** A deadline leaves repeated reads in progress, and a depth quota rejects a valid deep ancestry. Membership in the current traversal detects exactly the repeated identity.

## Consequences

A corrupted repeated parent identity cannot hang native binding lookup or supply a root grant. Valid ancestry resolution and every current ownership check retain their original behavior. The native producer work bound and capacity deadlines remain separate and unchanged.
