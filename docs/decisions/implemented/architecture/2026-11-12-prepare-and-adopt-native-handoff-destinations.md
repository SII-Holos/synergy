# Decision Record: Prepare and adopt native handoff destinations

Status: implemented

## Problem

Verified transport bytes do not establish a prepared native destination. Every Session requires its exact owner partitions, destination mapping, paused epoch reservation and organization binding adoption. Copying source Runtime objects into a target fixture cannot establish cold destination recovery.

## Decision

The organization Runtime's destination owner snapshots its inputs and verifies a finite service-signed machine plan against the current deployment, machine and connection before preparation. Its instance binds the actual Runtime, Store and artifact configuration, and verifies that this Home's current enrollment owns the authorized machine, organization and deployment before receiving bytes. Source and destination reuse the same owning Home verifier. It receives immutable package frames through the private destination cache, verifies the complete staged bytes and checks the reader digest and canonical aggregate against the authoritative frozen source fact.

Destination member metadata comes from the verified staged Core partitions in parent-first order. Each member receives its exact native epoch reservation. Registered owners validate their own partitions using an explicitly resolved destination mapping and their declared dependencies; a current Workspace without the Workspace portability owner remains blocked. The owner hashes the normalized mappings with stable key ordering and retains one immutable preparation fact. Preparing again cannot replace that fact with another mapping. Concurrent preparations for the same immutable tuple and connection join one native job; inspection reports that job as working until its permanent fact exists. A finite HTTP observer ending does not end the machine connection lifetime. Disconnecting the connection still cancels and drains its accepted callbacks, and each object range obtains fresh current service authority.

Activation requires the independently signed organization activation permit and its exact retained preparation hash. The owner rebuilds and validates destination contexts from private staged records, then enters the native aggregate activation with the organization adoption authority. Core publication follows parent order before other owner publication. Every canonical Session, current binding, epoch pointer and activated receipt commits in the same transaction while the root remains paused. A failed owner or receipt write leaves all members private and prepared. A duplicate activated result verifies its permanent native epoch and returns its retained fact.

Prepared and activated facts are owner evidence for the machine connection to sign; this owner does not submit input, replay a prompt, issue an execution grant or request Continue. Main Runtime composition, human mapping selection, complete WorkspaceMove, returning-copy supersession, obsolete member retirement and shared-export continuity remain controller integrations rather than consequences of this native operation. The activation Kernel still receives aggregate context/binding collections; this change does not establish bounded memory for arbitrarily large aggregate publication.

## Alternatives considered

**Treat received bytes as prepared.** Transport hashes cannot prove native owner compatibility, mappings or canonical child closure.

**Reuse source Session objects during activation.** That ties recovery to another Runtime's memory and can hide missing target partitions.

**Copy the organization binding as ordinary metadata.** A target would retain the old driver or weaken immutable Session ownership. The existing adoption owner verifies the separate permit under native epoch activation.

**Publish members and the activation receipt separately.** A failed final receipt would leave visible Sessions without the durable outcome needed for unknown-result reconciliation.

## Consequences

`test/handoff-target.test.ts` uses an actual HTTPS-enrolled hosted destination Home and real source storage, native object owners, organization command partitions, complete staged membership and independent service signing keys. A valid signed plan in another native Home is rejected before object reads, reservation or receipt writes. Concurrent calls retain one exact native preparation while inspection sees working. The target closes and reopens after preparation; canonical Sessions remain absent. A changed mapping and invalid activation signature are rejected. Failure of the final activated receipt rolls back both members and their epoch pointers; retry publishes both paused with the new driver/epoch. The original queued item, message identity and account actor remain singular, and duplicate activation retains its fact. Original cancellation survives caller signal replacement during real signature verification and held mapping resolution. Inspection checks permanent native outcomes without publication or replay. This fixture does not assert that the complete Main controller is mounted.

Native destination retirement, complete Workspace and resource mappings, grant closure and production composition remain separate dependencies. These primitives cannot advertise a complete product handoff on their own.
