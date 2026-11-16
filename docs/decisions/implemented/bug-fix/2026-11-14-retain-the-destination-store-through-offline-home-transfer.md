# Decision Record: Retain the destination Store through offline Home transfer

Status: implemented

## Problem

Offline data commands acquire native directory retirement claims without a canonical parent Store. The original claim owner rejects that missing primary. Keeping a source writer open instead would conflict with removing the original Home, and reopening a target writer inside an import would create a second transaction owner. An asynchronous return inside the move's Home-lock scope also releases those locks before the returned copy operation settles.

## Decision

Offline move and merge borrow the actual initialized destination Store through their original native claims and import. The existing locked upgrade prepares the Homes before attachment. Source readers validate their original state and close before source removal; the one destination writer closes only after all original claims release. Pack borrows its actual readonly source Store. No empty Store or guard exemption supplies authority.

The original data-import position revalidates the target through `StorageBootstrap.inspect` and compares its actual dataset identity with the attached handle. The storage root retains its original configuration identity; its canonical physical path serves only directory ownership and containment. Replacing a target configuration refuses publication without changing the original manifest or deleting source bytes. Move awaits the complete operation before disposing its Home locks on success or failure.

## Alternatives considered

**Bypass the canonical Store requirement for offline commands.** Home locks do not replace canonical Runtime and dataset admission.

**Keep the source Store open until the move returns.** Removing the source while its readers or writer remain alive can retain locks or recreate its directory during cleanup.

**Prepare another destination writer at import time.** Two handles would split the original primary and explicit transaction owner. The attached actual writer is reused instead.

**Use the physical realpath as the storage configuration root.** Path aliases can identify the same directory while contributing different configured dataset identities. Physical containment and storage configuration retain their distinct inputs.

## Consequences

Real move, pack and merge tests retain bytes, destination collisions, native catalogs, Git relationships and source-removal checks. A held target attachment exposes real competing Home-lock acquisition before completion and after failure. A configuration-drift regression verifies refusal and successful reuse after restoring the original configuration. Bare internal merge requires the initialized target established by the offline entrypoint; it cannot initialize an absent target without that owner.
