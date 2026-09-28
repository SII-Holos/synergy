# Decision Record: Verify failure boundaries before native effects and after Docker loss

Status: implemented

## Problem

A native unrestricted process can reach a materialized Workspace owned by another Environment. Saving only its declared Workspace would miss those changes. A removed Docker container can leave a staging volume and network; those remnants do not mean a previously running allocation is still being created.

## Decision

Native physical admission verifies that every reachable materialized Workspace belongs to the command's captured result set. It rejects an uncovered view before process activation and releases the claim. This check runs while the physical write boundary is held, after concurrent mounting has settled.

Docker inspection uses the persisted incarnation receipt to distinguish a lost running container from partial initial provisioning. Confirmed loss marks attached views unavailable while retaining their files, claims and saved heads. Repeated inspection of the same loss does not manufacture new catalog revisions.

The CI plan includes a mandatory Docker execution task for affected owners. It builds the Execution Host and runs real allocation, saving, recovery, PTY and authenticated TLS tests with the integration image explicitly supplied.

## Alternatives considered

Capturing another Environment's files would cross its ownership and acknowledgement boundary. Assuming leftover staging means pending allocation would never report a lost view. Leaving Docker tests opt-in alone would allow regressions to pass CI without execution evidence.

## Consequences

Users narrow a native write boundary or detach other live views before unrestricted execution. Lost compute stays unavailable until explicitly reconciled; saved-copy recovery remains separate. Behavioral tests verify rejection before side effects, container loss, retained views and executable CI coverage.
