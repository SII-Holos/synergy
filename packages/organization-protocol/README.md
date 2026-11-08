# Organization protocol

Strict schemas shared by the standalone organization service, Runtime bridge and clients. Protocol versions are independent of product release versions. Private local Session registration accepts only its specified metadata.

Use the public package entry for schemas and inferred types. Storage and execution implementations belong to their respective owners.

Machine proofs and command permits use separate versioned Ed25519 signing domains over strictly validated claims. Command actor fields reuse the portable account attribution schema. A valid signature establishes the signed claims; execution owners must still validate the current target, connection, binding, deadline and admission receipt. Compile the protocol and Util packages before importing their JavaScript entries from Node.

Input and control digests bind the logical request, organization, complete target and payload. Continue requires the observed native pause and Runtime control version; cancel requires an explicit run and observed version; pause supplies no caller-selected identity or force flag. Skip proofs use their own signing domain and retain the original command while authorizing reconciliation on a current connection. Accepted effects and terminal attempts have separate schemas; rejecting an attempt does not make the logical request permanently unexecutable.

Cancellation queries may carry a current execution observation beside the immutable result. Its root and observation window must match the accepted cancellation. Unavailable evidence is explicit; execution observations are excluded from persisted command results.

Resource schemas separate administrator configuration and credential input from portable member descriptors. They declare supported protocols, fixed ownership, model capabilities and revisioned account/project use grants. Public descriptors contain neither upstream endpoints nor secret values; command and execution authority remain separate.
