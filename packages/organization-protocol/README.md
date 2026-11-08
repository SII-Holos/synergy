# Organization protocol

Strict schemas shared by the standalone organization service, Runtime bridge and clients. Protocol versions are independent of product release versions. Private local Session registration accepts only its specified metadata.

Use the public package entry for schemas and inferred types. Storage and execution implementations belong to their respective owners.

Machine proofs and command permits use separate versioned Ed25519 signing domains over strictly validated claims. Command actor fields reuse the portable account attribution schema. A valid signature establishes the signed claims; execution owners must still validate the current target, connection, binding, deadline and admission receipt. Compile the protocol and Util packages before importing their JavaScript entries from Node.
