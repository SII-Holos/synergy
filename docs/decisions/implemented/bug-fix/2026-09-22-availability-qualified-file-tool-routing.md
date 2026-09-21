# Decision Record: Availability-qualified file-tool routing

Status: implemented

## Problem

Shared file-tool descriptions can recommend capabilities that the active agent cannot use. Native Flash permits `file_search` and classic reading/editing tools while denying the dedicated Glob/Grep and anchored tool families. Unconditional recommendations in Bash and file search therefore conflict with the emitted tool catalog.

## Decision

The [Bash description](../../../../packages/runtime-local/src/tools/bash.txt) qualifies specialized search recommendations by availability and names `file_search` as the alternate route. The [file-search description](../../../../packages/runtime-local/src/tools/file-search.txt) qualifies anchored search, syntax queries and reading by availability, and explains how to narrow literal queries when specialized search is unavailable. Both descriptions distinguish classic and anchored readers without binding shared instructions to an agent name.

The change preserves the shell file-operation prohibition, tool schemas, execution implementations, permissions and exposure. Discovery and expansion do not authorize denied tools. The [emitted-description regression](../../../../packages/runtime-local/test/agent/synergy-flash-tools.test.ts) exercises native Flash, Synergy and Synergy Max through the registry in isolated Scopes.

## Alternatives considered

**Enable every recommended tool for Flash.** This changes the agent's deliberately reduced surface and treats an instruction error as a reason to broaden capability exposure.

**Add agent-specific prompt overrides or description builders.** Conditional wording expresses the shared behavior without introducing per-agent templates or coupling runtime-local tools to agent identities. An override can also leave the original contradictory tool description intact.

**Permit shell search whenever a dedicated tool is missing.** That changes the file-operation policy instead of repairing the guidance. Narrow literal search and an available reader preserve the existing policy.

## Consequences

Reduced tool catalogs receive a usable file-discovery and inspection route, while richer catalogs retain specialized tools. The descriptions are slightly longer and still rely on the model to respect availability. Deterministic tests establish emitted guidance, not model compliance or benchmark gains; those require separately frozen whole-task comparisons with complete cost accounting.

The [R9 development preset](../../../../benchmark/configs/qwen38-iter-r9.yaml) compares a fixed baseline revision with a separately frozen candidate using native Flash and unchanged development-suite budgets. Its endpoint is a non-routable example, not a deployment binding. The [preset regression](../../../../benchmark/test/test_experiment_presets.py) verifies paired scheduling and launch settings. The [benchmark reference](../../../../benchmark/README.md) distinguishes suite scoring budgets from the native oracle's upstream limits. Oracle and doctor checks remain independent prerequisites; an oracle environment timeout blocks scoring, not grounds for silently extending a deadline or omitting a task. Five reused development tasks cannot establish general superiority or statistical non-inferiority.
