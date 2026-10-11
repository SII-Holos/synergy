# Decision Record: Bound interactive history reads before fetching record bodies

Status: implemented

## Problem

Owner-local history preparation can still block a large installed database when a limited prefix query scans the entire storage namespace. Repeating display preparation for every message in a body batch multiplies that cost. Automatically loading complete execution details after navigation can independently replay an old task's entire journal while ordinary conversation requests wait.

## Decision

Prefix-only ordered queries drive exact record lookups from the existing node tree. Immediate-child key pages materialize their limited candidate set before live-record probes, preserving cursor progress through empty branches. Message-order pagination uses that primitive. Targeted body reads prepare only the requested canonical header while retaining migration, visibility and version checks.

The Web execution summary controller records explicit details demand for the current Session. Navigation clears that demand and cancels pending reads; focus and reconnect cannot introduce a new full-history aggregate. Complete details remain available on request, and conversation execution state continues through its bounded visible-turn API.

Pause recovery uses transactionally maintained pending-owner records and compare-and-remove acknowledgements. Historical owners enter through a versioned on-access metadata migration, with detail access reconciling only that Session. Header-only pending-reply discovery preserves compaction semantics. Light Loop recovery selects navigation and terminal-record candidates instead of hydrating every Session.

Desktop preserves an observed Runtime startup failure in child-exit errors, whether the child exits before or during a health request. Advancing progress and fixed maintenance budgets retain their existing deadline rules.

Verification combines SQL-plan and read-volume assertions with rendered-text and composer measurements on an isolated installed-data copy. CI enforces bounded work and generous hang guards; machine-specific experience measurements remain separate evidence. See the [performance verification rules](../../../../.synergy/skill/testing-guide/references/local-verification.md#local-performance-experiments).

## Alternatives considered

**Increase storage or Desktop timeouts.** Longer waiting leaves ordinary requests competing with the same historical work and obscures a child's actual failure.

**Build another global index at startup.** Rewriting a large installation's history to accelerate a small requested page recreates the migration regression.

**Trust cached display headers without reading canonical messages.** This avoids work at the cost of stale content versions, semantic upgrades and rollback behavior.

**Prepare complete task details after every navigation.** Nonblocking rendering alone does not prevent the shared backend from spending minutes replaying unrequested history.

## Consequences

Ordinary navigation avoids global record scans and automatic complete execution replay without a global persisted-data rewrite. Recovery enrollment adds an owner-local pending record and migration receipt. Child-node sorting is confined to the selected parent; it does not promise constant work for arbitrarily many child nodes. Explicit full task analysis retains its complete-evidence semantics and can remain expensive. SQL traversal, hydration, demand lifecycle and startup-exit regressions protect separate failure mechanisms.
