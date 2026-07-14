---
name: change-execution-boundaries
description: Add, modify, or review Synergy capability classification, control profiles, permission rules, SmartAllow eligibility, workspace and sensitive-path policy, tool enforcement, or macOS/Linux/Windows sandbox behavior. Use for packages/synergy/src/control-profile, enforcement, permission, sandbox, session/tool-resolver, or shared capability definitions.
---

# Change Execution Boundaries

## Trace the Whole Decision

1. Read [Execution boundaries](../../../docs/architecture/execution-boundaries.md) and `packages/synergy/AGENTS.md`.
2. Start at `session/tool-resolver.ts`, then trace the operation through capability classification, the enforcement gate, profile compilation, saved/session permission layers, SmartAllow, approval side effects, sandbox policy, and the tool implementation.
3. Inspect `packages/util/src/capability.ts` for the shared capability catalog and public severity/category metadata. Keep classification independent from profile policy: classifiers describe what an operation can do; profiles decide allow, ask, or deny.
4. Check built-in tools, plugin and MCP envelopes, worktree/main-checkout reclassification, sensitive paths, remote execution, and platform fallback before assuming one call site owns the boundary.

## Preserve the Security Model

1. Route every executable path through the centralized gate. Do not move authorization into one tool or treat visibility, authorization, and sandboxing as the same decision.
2. Keep `guarded` interactive, `autonomous` non-prompting, and `full_access` permission-silent without suppressing ordinary runtime failures.
3. Mark hard boundaries non-bypassable at the capability definition or classification source. SmartAllow and preauthorization must not override hard denials or receive raw secrets.
4. Keep the active workspace as the default write/execute boundary. Preserve original-checkout and sibling-worktree protection, trusted-root containment, protected metadata, and credential-path rules.
5. Treat sandboxing as post-authorization containment. Preserve filesystem roots, network mode, approved external roots, shell-bypass semantics, and the configured `deny`/`warn`/`allow` fallback.
6. Change platform helpers and TypeScript policy together. Do not claim parity without the relevant macOS Seatbelt, Linux helper/Bubblewrap, Windows helper, or WSL evidence.
7. Treat persisted workflow, agent, and plugin definitions as untrusted policy inputs, not authorization grants. A child session must inherit its launcher's effective boundary unless a separate execution-time authorization explicitly permits an override; writing `session_state` alone must never mint `autonomous` or `full_access` authority.

## Implement and Verify

1. Write the failing behavioral test at the lowest owner: pure classifier, profile decision, permission layering, gate envelope, sandbox policy, or platform dispatch.
2. When adding or changing a capability, update its shared definition, risk/non-bypassable metadata, every classifier and manifest mapping, permission presentation, and focused tests.
3. Test both positive and adversarial forms, including argument aliases, shell wrappers, external/protected paths, main checkout versus worktree, saved deny precedence, autonomous ask-to-deny behavior, and sandbox-unavailable fallback.
4. Run focused suites under `test/control-profile`, `test/enforcement`, `test/permission`, `test/sandbox`, and `test/workspace` as applicable, then typecheck and `bun run quality:quick`.
5. Use `develop-synergy` for platform or end-to-end shell verification. Never experiment against the runtime carrying the current task.

Update the architecture document when the pipeline, profile semantics, capability contract, workspace boundary, or sandbox guarantee changes. Update `git-guide`, `add-tool`, or `change-plugin-runtime` when their executable workflow depends on the new classification.

## Handoff

Report the capability and risk, classifier, profile decisions, bypassability, permission/SmartAllow behavior, sandbox policy and platform coverage, workspace effects, tests, and documentation synchronized.
