# Organization protocol

Gateway requests and invocation capabilities use separate signing domains. Each capability binds a single call, current execution identities, resource revision and bounded start/lifetime/byte limits. Metadata receipts distinguish reservation, started transmission, transport completion and unknown outcome without carrying content or upstream credentials.

Resource-description proofs carry accepted input evidence without a root claim. Ordered descriptors must exactly match the active grant's model and connection selection; their strict schema excludes endpoints and credentials. Description and root-binding signatures are not interchangeable.

Strict schemas shared by the standalone organization service, Runtime bridge and clients. Protocol versions are independent of product release versions. Private local Session registration accepts only its specified metadata.

Use the public package entry for schemas and inferred types. Storage and execution implementations belong to their respective owners.

Machine proofs and command permits use separate versioned Ed25519 signing domains over strictly validated claims. Command actor fields reuse the portable account attribution schema. A valid signature establishes the signed claims; execution owners must still validate the current target, connection, binding, deadline and admission receipt. Compile the protocol and Util packages before importing their JavaScript entries from Node.

Input and control digests bind the logical request, organization, complete target and payload. Continue requires the observed native pause and Runtime control version; cancel requires an explicit run and observed version; pause supplies no caller-selected identity or force flag. Skip proofs use their own signing domain and retain the original command while authorizing reconciliation on a current connection. Accepted effects and terminal attempts have separate schemas; rejecting an attempt does not make the logical request permanently unexecutable.

Cancellation queries may carry a current execution observation beside the immutable result. Its root and observation window must match the accepted cancellation. Unavailable evidence is explicit; execution observations are excluded from persisted command results.

Resource schemas separate administrator configuration and credential input from portable member descriptors. They declare supported protocols, fixed ownership, model capabilities and revisioned account/project use grants. Public descriptors contain neither upstream endpoints nor secret values; command and execution authority remain separate.

Execution schemas distinguish Session resource selection, version-two provisional/bound/closed grants and finite machine root-binding proofs. Grants bound individual calls without adding a lifetime task quota. The proof signs the complete accepted task receipt and exact root/connection identity in a separate domain; selection rejects duplicate identities and arbitrary transport settings. Public Session directory metadata excludes internal grant IDs and occupancy counts.
