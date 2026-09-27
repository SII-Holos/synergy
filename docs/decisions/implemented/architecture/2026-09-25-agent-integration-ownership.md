# Decision Record: Independent agent integration ownership

Status: implemented

## Problem

MCP, LSP, formatting, ACP, external agents, remote Link connections and code tools shared one package and one configuration registration. Consumers selecting one integration acquired unrelated mechanisms and could not register its configuration independently. LSP startup also initialized formatting implicitly.

## Decision

Each integration owns its package, exports, tests, configuration and startup contributions. LSP and Formatter register independently; complete product composition registers Formatter before LSP. Existing domain configuration filenames, field names, tool names and native Workspace ownership remain stable. Integration tests that exercise formatting or LSP reside with that owner rather than the local execution implementation.

## Alternatives considered

**Keep the aggregate and expose more subpaths.** Subpaths improve imports but retain the aggregate installation dependencies and shared configuration registration.

**Move every integration into an ordinary process plugin.** Native services participate in Workspace coordination and startup registration; changing their execution and trust model would exceed package ownership changes and risk losing those guarantees.

## Consequences

Each integration has an explicit independently verifiable dependency graph. Complete products compose all selected owners, while embedding callers select only the required integrations. Release, coverage and native test inventories follow the new owners and retain the existing quality thresholds.
