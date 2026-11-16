# Decision Record: Authorize Session directory metadata

Status: implemented

## Problem

The service needs stable Session ownership and driver references to authorize collaboration. Reading all Session metadata before filtering would reveal private identities through pages and counts. Organization administration also cannot imply access to another person's private work, and recording a directory row cannot establish that a separate Runtime accepted a command.

## Decision

Keep a strict versioned organization directory outside Harness Session storage. Private reservation derives creator identity from authenticated current authority and checks project execution access plus ownership of an active member registration. The record and creator/visibility indexes join the caller's transaction. There is no standalone public reservation endpoint, and the reservation creates neither a Runtime Session nor an execution grant.

Use the common authorization owner for directory access. Private entries require their creator's current project access; shared metadata follows project read access. Execute eligibility additionally checks the project role, lifecycle and handoff lock. Clients cannot replace the stored project with a request-body claim.

List from the caller's creator index and the project's shared index, merge and deduplicate their ordered identities, then load one bounded canonical page inside the same snapshot. Count visibility indexes for administrator capacity without loading or enumerating private entries. Public views omit internal control fields and all conversation content.

## Alternatives considered

**Fetch all records and filter the response.** Pagination and counts would be computed over unauthorized identities, and private data would be loaded needlessly.

**Let administrators read private directory entries.** The organization role permits capacity administration, not access to another creator's private metadata.

**Expose reservation as successful Session creation.** Service metadata and Runtime acceptance are different durable facts. Trusted command admission and the Runtime's receipt must establish execution separately.

## Consequences

Generated organization clients expose metadata lookup, authorized pagination and anonymous counts. New versioned records introduce no historical rewrite; no prior private Session content is uploaded or adopted. Tests use real SQL, HTTP and generated clients for rollback, competing reservations, restart, revocation, archive state and pagination across mixed owners. Sharing mutations, content synchronization and trusted command delivery remain with their respective owners.
