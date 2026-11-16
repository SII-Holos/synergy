# Decision Record: Retire the original service before source recovery completes

Status: implemented

## Problem

A frozen source can still restart with its original credentials and database. A retirement reservation proves an irreversible intent, while a pathname-based marker or an interrupted observer cannot prove that the original service's native Home was fenced. Recovery must finish the same accepted intent after a crash without reconstructing an old Runtime lease or activating source authentication.

## Decision

The trusted Host first obtains a reference from the original `OrganizationCurrentAuthority.Source`. The strict reference binds its verified namespace and native hashes, final journal checkpoint and optional historical anchor, original target installation/request metadata, original Home owner, native physical hash and primary Store configuration digest. It contains no native path, database connection string or credential. The target reference records association only; it is not a target-ready or activation proof.

Only `OrganizationCurrentAuthority.retire` admits a new reservation. It consumes the private original source evidence, repeats verification, checks the original primary Store and installed process lock, and adds those native checks to the actual reservation transaction's final commit guard. There is no public callback that can substitute for current source verification. The kernel retains the one reference hash on the existing frozen maintenance operation; it never releases that operation afterward.

After the reservation commits, completion no longer depends on the observer signal. The native Home owner publishes format four through its original regular file descriptor and synchronizes it. Source capture joins accepted completion before its callback closes, and service shutdown drains accepted work before closing the Store or releasing the native process lock. Failed or lost acknowledgements retain the exact same intent.

The restricted `openOrganizationSourceRetirement` entry selects only the exact original Home or its expected retired marker. It opens the actual primary Store under a fresh canonical process lock, validates the existing reservation and reference, and can only complete that same fence. It runs no migrations, authentication, active signer, HTTP or machine transport. The owning Home parser alone recognizes an exact deterministic marker prefix after interruption; repair still waits for the matching kernel reservation, Store configuration and physical Home checks. Normal startup rejects the partial file and the retired format.

The resulting opaque receipt belongs to its actual source Runtime, primary Store and installed process lock. It proves permanent fencing of this service control plane. Its retained checkpoint metadata is not a new current-policy capability, and its target metadata grants no execution authority.

## Alternatives considered

**Treat the frozen reservation as physical retirement.** The original Home could still be opened by an old reader before the file effect completes.

**Change only the format-two reader-contract string.** The released format-two parser accepts arbitrary reader strings, so it can still open original credentials and SQL.

**Cancel file publication with the observing request.** After the permanent intent commits, cancellation cannot roll it back; abandoning the file effect can leave the source runnable.

**Recreate a maintenance lease after restart.** The original lease belongs to its original Runtime. Cold completion instead verifies the retained immutable reservation without changing its source identity or frozen facts.

## Consequences

The source service has a recoverable permanent retirement boundary, with separate intent and native-effect evidence. Operator recovery must retain the exact reference and archives. Member and hosted writers, resource systems, current target ACL publication, active signing and target readiness remain separate required owners.

`packages/organization/test/backup/source-retirement.test.ts` uses real temporary service Homes to cover live retirement, cold completion before and after the file effect, exact prefix repair, copied Homes, wrong references, original cancellation before reservation, lost file acknowledgements and accepted completion during observer cancellation and shutdown. Existing current-authority, inactive-signing, Home and restricted-recovery suites preserve their independent contracts.
