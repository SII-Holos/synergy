# Decision Record: Select embedded default Agent families

Status: implemented

## Problem

Explicit component selection still installed every primary and subagent catalog from the Harness. Embedded hosts could not contribute their own Agent identity while retaining only the internal title, summary and compaction agents.

## Decision

Allow composition to select the primary, legacy, max and internal default Agent families before Runtime startup. Unselected product compositions retain the complete default catalog. Domain factories remain explicit contributions. Family selection and factory registration are Runtime-owned and sealed before startup.

## Alternatives considered

Disabling every unwanted Agent through configuration makes the host depend on an expanding product inventory. Copying internal factories creates a second implementation. Both are avoided by selecting the owning families.

## Consequences

Hosts can contribute one visible primary Agent without unrelated product identities. Two real Runtime fixtures verify empty and internal-only selections, preserved domain contributions, isolation and rejection of late registration. Existing Agent configuration and delegation tests retain default product behavior.
