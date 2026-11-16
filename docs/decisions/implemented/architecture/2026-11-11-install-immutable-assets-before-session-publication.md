# Decision Record: Install immutable Assets before Session publication

Status: implemented

## Problem

Portable history can reference native Assets larger than an archive frame. Buffering their full body prevents bounded transfer, while copying only SQL aliases does not make an Asset readable in a Runtime whose existing authority is the canonical file owner.

## Decision

Add `Asset.open()` and `Asset.installStream()` to the existing owner. Native reads capture file identity, length and full checksum, stream bounded chunks and reject replaced, changed or symbolic-link content. Installation verifies the declared length, checksum and immutable ID before creating the canonical filename without overwriting an existing object. An existing ID must retain the same complete content. Ordinary Asset publication uses this same immutable installation rule.

Physical content installation precedes Session activation and rejects invocation inside a Storage transaction. A verified object may exist before any imported Session reference is published. Session records, indexes, navigation and execution authority remain separately controlled by the activation transaction; filesystem installation is not part of that transaction. Cancellation preserves installed content that another reference may use. Temporary incomplete writes are removed; reclamation of installed unreferenced objects remains an Asset owner responsibility.

The explicitly selected stored Asset backend implements streaming inspection and installation through its existing metadata and prepared binary references. `Asset.read()` streams that selected authority into its reconstructible native cache, including repair of corrupt cache files. It still fails when the selected authority is unavailable rather than returning a retained cache. Native file authority remains the production default; transfer does not enable another persistence mode or add a second read authority. An injected backend supplies its own streaming installation operation; legacy backend readers retain their existing materialization behavior.

Organization Runtime listeners require an explicit private credential and bind to loopback. Their ordinary Asset route remains behind the server bearer middleware. The organization service does not provide an arbitrary Asset hash proxy. Any future organization attachment download operation must establish its own visible Session and project authorization before exposing content.

## Alternatives considered

**Write only an imported SQL Asset manifest.** Native `Asset.read()` would still consult its selected file owner and fail to resolve the imported object.

**Enable SQL Asset storage during transfer.** Changing persistence mode would require an owning migration of all existing native objects and affect unrelated Sessions.

**Install files inside the activation callback.** Filesystem effects cannot roll back with retryable SQL mutations.

## Consequences

Native content becomes independently readable before Session publication, and retries reuse the exact immutable object. Real owner tests cover a 65 MiB streamed object, existing objects, invalid byte counts, collision preservation, changed files, symlink rejection and restart through the explicitly selected stored backend. These owner operations do not by themselves certify an aggregate dependency closure or a signed Runtime handoff.
