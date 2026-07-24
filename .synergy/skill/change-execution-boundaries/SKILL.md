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
2. Keep model presentation and execution separate. `ToolCatalog` sent to an Agent worker contains only serializable schemas; executable callbacks and permission state remain in the Control Plane and enter `ToolScheduler` only after the Agent stream is disposed.
3. Keep production capability analysis in the bounded Policy worker pool. The worker receives immutable classification context and returns capabilities; profile decisions, approvals, audit state, sandbox accumulation, and execution remain in the Control Plane.
4. Make classification termination explicit. A parser or classifier must share one time/depth/active-input budget and return a finite conservative capability on no progress, repeated input, or excessive depth. It must never restart its public top-level entry point to handle those conditions.
5. Keep `guarded` interactive, `autonomous` non-prompting, and `full_access` permission-silent without suppressing ordinary runtime failures.
6. Mark hard boundaries non-bypassable at the capability definition or classification source. SmartAllow and preauthorization must not override hard denials or receive raw secrets.
7. Keep the active workspace as the default write/execute boundary. Preserve original-checkout and sibling-worktree protection, trusted-root containment, protected metadata, and credential-path rules.
8. Treat sandboxing as post-authorization containment. Preserve filesystem roots, network mode, approved external roots, shell-bypass semantics, and the configured `deny`/`warn`/`allow` fallback.
9. Change platform helpers and TypeScript policy together. Do not claim parity without the relevant macOS Seatbelt, Linux helper/Bubblewrap, Windows helper, or WSL evidence.

## Implement and Verify

1. Write the failing behavioral test at the lowest owner: pure classifier, profile decision, permission layering, gate envelope, sandbox policy, or platform dispatch.
2. When adding or changing a capability, update its shared definition, risk/non-bypassable metadata, every classifier and manifest mapping, permission presentation, and focused tests.
3. When changing dispatch location or executor class, update `ToolExecutor.classify()`, per-executor admission tests, cancellation/failure containment tests, and the execution-boundary documentation. Executor classification is scheduling metadata and cannot replace capability classification.
4. Test both positive and adversarial forms, including argument aliases, shell wrappers, compound-operator lexical parity, no-progress/depth/repetition termination, external/protected paths, main checkout versus worktree, saved deny precedence, autonomous ask-to-deny behavior, Policy worker timeout/crash/replacement, conservative fallback, sandbox-unavailable fallback, queue saturation, duplicate call identity, and executor crash/cancellation.
5. Run focused suites under `test/control-profile`, `test/enforcement`, `test/permission`, `test/sandbox`, `test/session`, and `test/workspace` as applicable, then typecheck and `bun run quality:quick`.
6. Use `develop-synergy` for platform or end-to-end shell verification. Never experiment against the runtime carrying the current task.
7. For packaged Linux or Windows sandboxes, build helpers per supported OS, architecture, and ABI before compiling the runtime. Embed the matching helper digest, fail a Stable build when an asset is missing, preserve the helper through every installer/package layout, and validate the installed artifact rather than only the source build.

Update the architecture document when the pipeline, profile semantics, capability contract, workspace boundary, or sandbox guarantee changes. Update `git-guide`, `add-tool`, or `change-plugin-runtime` when their executable workflow depends on the new classification.

## Handoff

Report the capability and risk, classifier, profile decisions, bypassability, permission/SmartAllow behavior, sandbox policy and platform coverage, workspace effects, tests, and documentation synchronized.
