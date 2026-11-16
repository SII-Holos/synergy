# Decision Record: Establish organization command signing

Status: implemented

## Problem

An authenticated machine connection establishes a peer and connection epoch. Command admission also needs durable evidence binding one logical request, its actor, exact target and authorization decision. An ephemeral signing key would make that evidence change after ordinary service restart, while placing private signing material in a handshake would expose service authority.

## Decision

Create a versioned Ed25519 service identity through the organization's central startup migration. Bind it to the existing organization and deployment incarnation, retain it in the independent service database, and validate the key pair before readiness. Completed migration with unavailable or damaged credentials fails without generating a replacement. Interrupted migration may reuse an existing matching identity.

Include only the public identity in authenticated Runtime handshakes. Members check its deployment binding before publishing a connection checkpoint. Preserve the existing machine-proof encoding and use a separate fixed signing prefix for strict command permits. Reuse the portable account actor schema and bind actor/request identity, target, epochs, sequence, authorization/control revisions, admission/attempt IDs, payload digest and a finite signing window.

Keep signing separate from admission. Signature verification validates signed claims; the command owner must establish live service authorization and Runtime acceptance through their respective transactions. Adding these schemas and identity does not advertise command execution support.

## Alternatives considered

**Generate a new key on every start or missing-record error.** Restart and accidental credential loss would silently change service authority and make retained evidence ambiguous.

**Use one signing namespace for all proof families.** An otherwise valid signed object could be interpreted under the wrong protocol purpose. Fixed domain prefixes and strict schemas keep those uses separate.

**Duplicate account actor definitions in the protocol package.** Divergent identity fields would weaken attribution continuity. The protocol depends only on Util's portable schema, with a compiled Node entry for that shared module.

## Consequences

The new migration extends the prior service ledger without rewriting its deployment identity. Private key material stays out of public APIs, handshakes and Session transfers. Tests cover real cryptographic tampering, signature-domain separation, prior-ledger upgrade, migration retry, restart, damaged credentials and real member sockets. Command transport, persistent receipt deduplication and resource grants remain separate implementation work.
