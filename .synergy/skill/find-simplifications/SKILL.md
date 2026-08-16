---
name: find-simplifications
description: Turn a broad "find things to simplify" request into evidence-backed simplification decision records and inline notes for the Synergy repo. Use for dead, duplicated, speculative, over-built, added-then-removed, or hand-rolled-where-a-dependency-exists surfaces; for auditing or coalescing superseded decision records; or for folding worthwhile simplifications from another PR.
---

# Finding Synergy Simplifications

This skill helps turn a broad "find things to simplify" request into evidence-backed decision records that remove or collapse existing surface area. It is guidance, not a checklist: follow the code, keep judgment active, and prefer a few well-proven candidates over a pile of thin guesses.

## Start With Repo Context

- Read the root [AGENTS.md](../../../AGENTS.md) — especially the [Durable Architecture Boundaries](../../../AGENTS.md#durable-architecture-boundaries) — and the [documentation standard](../../../docs/AGENTS.md). The boundaries listed there are intentional by default; a simplification that collapses one needs to beat the recorded rationale, not just cite churn.
- Skim [Architecture overview](../../../docs/architecture/README.md) and [Decision records](../../../docs/decisions/README.md) before judging anything under `packages/`. Simplifications that fight the runtime vocabulary or the decision-record format need extra evidence.
- Read only the relevant owned-domain document: [Sessions and messages](../../../docs/architecture/session-and-messages.md), [LLM loop](../../../docs/architecture/llm-loop.md), [Frontend data sync](../../../docs/architecture/frontend-data-sync.md), [Execution boundaries](../../../docs/architecture/execution-boundaries.md), [Workflows](../../../docs/architecture/workflows.md), [Browser runtime](../../../docs/architecture/browser-runtime.md), [Channels](../../../docs/architecture/channels.md), [Cortex](../../../docs/architecture/cortex.md), or [Plugin documentation](../../../docs/plugins/README.md).
- Treat the durable boundaries as intentional by default: `guarded` as the only standard interactive profile, autonomous-never-asks, worktree isolation semantics, Browser desktop-native `WebContentsView` and Web WebRTC presentation as first-class modes, and `MessageV2.deriveSemantics()` as the only source of message semantics. Do not propose deleting any of these as "low effort" unless the user explicitly overrides that constraint. Removing an unused method or hook inside a protected seam can still be valid if it does not collapse the protected design.

## What Counts As A Strong Candidate

A strong simplification removes, folds, or demotes something real and has clear evidence that the current design costs more than it buys:

- A public method, event, config knob, registry notification, helper, package, durable event, or test artifact has no production consumer.
- Tests or docs are the only consumers, and the behavior they pin is not load-bearing.
- Two representations mirror the same fact, especially across durable session events and transient frontend events.
- A seam has methods every implementation must support but no consumer uses.
- A separate package exists only for test/demo/support code and adds publish or dependency overhead.
- A feature implements speculative product generality: multi-session/session-load, background job rosters, live registry invalidation, mid-turn steering, tool-owned UI rendering, and similar designs with no product owner.
- An invariant, rollback path, set of expected outputs, or special-case test exists only to protect an unused API.
- Hand-rolled code reimplements what a well-maintained external package or a Bun/Node builtin at the runtime floor already provides, and the swap would delete the implementation plus its dedicated tests.
- The simplified behavior may differ slightly, but the new behavior is still reasonable and easier to explain.

Thin candidates are usually not enough for a decision record: deleting one typo, running `knip` once, removing an intentionally documented backend/adapter, or flagging "this looks complex" without call-site proof.

## Survey Broadly

Use parallel subagents when the user asks for breadth or many candidates. Give each agent a domain and require evidence, not guesses. Useful domains:

- Agent loop and session lifecycle: turn/step boundaries, steering, abort/cancel, durable events, replay, load/resume, compaction.
- Channel and messaging: targets, provider lifecycle, managed Projects, task routing, diagnostics.
- LLM/tools/system prompt: stream/generate APIs, assemblers, registries, tool schema defaults, presentation hooks.
- Bash and tool execution: foreground/background split, job ownership, output spill files, executor methods, permission enforcement.
- Packages/scripts/tests: package splits, static inventories, redundant snapshot expected outputs, support packages, generated catalogs.
- Frontend: state stores, event sync, replay, eviction, component dead weight.

If subagents are unavailable, simulate the same breadth yourself. Do not let the first good candidate stop the survey.

Start with the largest production-code deltas. A broad simplification audit that stops after obvious unused symbols can miss the files where duplicated lifecycle or defensive machinery carries most of the cost.

## Audit Trust And Lifecycle Boundaries

For every defensive copy, freeze, validator, and callback capture, name where the value came from and who owns it next. Same-process typed service/plugin calls ordinarily borrow readonly values; parsers, config loaders, queues, model/tool JSON, durable files, workers, processes, and wire decoders own or validate their data. Tests built around hostile getters, fake typed objects, callback replacement, or mutation after a same-process handoff are evidence of a potentially speculative contract, not automatic justification for keeping it.

For complex asynchronous code, draw the ownership graph and map each sentinel, readiness promise, cancellation path, disposer, and state flag to a distinct owner or transition. When several mechanisms mirror the same liveness or settlement fact, propose one transaction or lifecycle controller instead. Preserve separate machinery where it protects synchronous publication and rollback, callback containment, first-terminal-outcome arbitration, worker/process ownership, or dispose-to-quiescence.

## Hand-Rolled Code Versus A Dependency

Introducing a dependency is a valid simplification move, not a policy exception. Synergy has no formal dependency policy; judge a swap on its own evidence. When surveying, ask of protocol parsers, framers, retry/backoff loops, glob matchers, diff engines, and similar infrastructure: does a well-maintained npm package or a Bun/Node builtin at the repo's runtime floor already do this?

Prove a dependency-swap candidate like any other, plus:

- Read the hand-rolled implementation and name the exact surface the package covers; residual semantics the package does not cover count against the swap and stay in the decision record.
- Check the package's health honestly (maintenance, adoption, transitive footprint) and prefer builtins when the runtime floor has them. Bun 1.3.14 is the current floor; the repo avoids inline coverage-ignore comments because that floor does not support them.
- Check the decision-record tree first: recorded seams and durable boundaries are settled — a swap that collapses one needs to beat the recorded rationale, not just cite the policy.
- Weigh net deletion: implementation plus dedicated tests plus docs, minus the glue that remains. A wrapper that relocates the same complexity is not a win.

## Prove Or Reject Each Candidate

For every symbol or behavior, classify consumers before writing:

- Production corpus: `packages/*/src`, `.synergy/skill`, runtime scripts, loader/config paths, and generated-catalog generators.
- Non-production corpus: tests, README/docs, decision records, snapshots, generated expected outputs, and comments.
- Ambiguous corpus: examples and scripts that may be product smoke paths. Inspect usage before classifying.

Use `scan_files` (regex, anchored results) and `file_search` (symbol/path lookup) first; use `parse_code` when structure matters. Good searches include the exact symbol, event name, package name, config key, method name with both `.name(` and `name(`, and any wire strings. Then read the call sites with `view_file`. `bun run deadcode` (knip) can help, but it is not a substitute for understanding public interfaces, dynamic event names, tests, docs, and loader paths.

Reject or downgrade a candidate when:

- A production caller exists and the simplification would be a feature decision rather than a cleanup.
- The API is explicitly justified by an implemented decision record or a hard-won durable boundary, and the new evidence does not beat that reason.
- The removal would force unrelated churn without actually reducing the public API or required behavior.
- The idea is correct but tiny. Add a targeted inline note instead (see below).

## Coalesce Superseded Decision Records

Audit the decision-record tree when the user asks to reduce or coalesce it, or when the simplification being implemented makes an owning record obsolete. Do not expand every code-simplification survey into a repository-wide record audit.

Follow the archiving rules in [Decision records](../../../docs/decisions/README.md); do not duplicate or weaken them here. Low-future-value implemented records move as frozen files to `archived/{class}/`; proposed records are never archived; rejected records that no longer prevent a tempting mistake are deleted. The `decision:check` gate enforces the path encoding, the in-file format, and the sha256 archive seal — never edit an archived record while simplifying current prose or code.

For each candidate chain:

1. Identify the current owner from shipped code, configuration, generated catalogs, package docs, newer decision records, and inbound links; dates and titles are discovery hints, not proof.
2. Classify the old record as fully or partially superseded. Any surviving behavior, current contract, durable format, compatibility obligation, or independently current rejected alternative makes it partial. Rationale that can be transferred to the current owner does not by itself make supersession partial.
3. For full supersession, move every unique rationale, alternative, consequence, shipped verification evidence, and named coverage gap into the current owner. An inventory that only describes deleted implementation mechanics is not one of those decision facts.
4. Repair every inbound link, then move the record to `archived/{class}/` in the same PR that supersedes it, adding the `Archived: YYYY-MM-DD` line below `Status:`.
5. Search exact filenames, symbols, config keys, event names, and wire strings after the edit. Keep partial supersessions cross-linked and current.

An added-then-removed feature is a common full-supersession case. Let the removal record own the history only when the feature is absent from production code, configuration, schemas, durable or wire formats, migration, and compatibility behavior; no current documentation presents it as available; and no test exercises it as supported behavior. Removal rationale and tests that enforce absence may remain. Preserve why the feature originally existed, why that motivation no longer justified it, alternatives to full removal, the capability given up, conditions for reintroduction, and evidence that removal is complete.

Reject consolidation when the removal is only one transport, default, implementation, or presentation of a feature; when persisted data or compatibility handling survives; or when the removal record does not yet carry enough rationale to prevent accidental reintroduction.

## Write The Decision Record

Create one file per durable proposal under `docs/decisions/{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`, following the lifecycle and classification rules in [Decision records](../../../docs/decisions/README.md). Keep prose paragraphs on one physical line and use relative Markdown links. The `decision:check` gate enforces the exact first three lines, the required sections, and the `Status:`/lifecycle match.

Use the `simplification` class for removal of code, behavior, or surface area. Prefer this structure, adjusting when the idea needs it:

- `# Decision Record: <action-oriented title>`
- `Status: proposed` (or `implemented` when the change already shipped)
- `## Problem`: name the current API, cite the relevant files, and state the consumer evidence. Separate production callers from tests/docs.
- `## Proposal` (proposed) or `## Decision` (implemented): say exactly what to remove, fold, demote, or rehome. Include tests, docs, READMEs, JSDoc, event-taxonomy, snapshot, and generated-file cleanup when relevant.
- `## Alternatives considered`: each genuine alternative and why it lost, one bold-led paragraph per alternative. Never invent alternatives.
- `## Acceptance criteria` (proposed) or `## Consequences` (implemented): observable end state and gates, or what the trade-off cost and bought.
- `## Risks`: public API changes, behavior changes, future product wants, and why the tradeoff is still reasonable (proposed only).

Be concrete enough that an implementing PR can follow the trail. Avoid vague "simplify this package" records. When a proposal overlaps an existing record, consolidate the useful details into the existing one rather than creating a duplicate.

## Inline Notes

Use inline comments with a stable tag only for small, local cleanups that are clearly useful but not durable design decisions. Keep them short and actionable:

- Name the smell with a stable tag in a short comment, e.g. `double-default` or `unused-default`.
- Explain why it is safe to revisit and what action would simplify it.
- Do not add comments for speculative complaints or for behavior that needs a decision-record-level decision.

## When Folding Another PR Or Branch

Diff the sibling branch against `origin/dev`, not against the current PR branch, so you see its independent contribution. For each item:

- Port non-overlapping decision records or inline notes that meet the quality bar.
- Consolidate overlapping material into the existing record that owns the topic.
- Do not port duplicate or lower-confidence proposals just to preserve the count.
- Update the PR body so reviewers see the true candidate count and scope.
- Close the duplicate PR only when the user asked you to, or when you clearly own that housekeeping.

## Validation And PR Hygiene

For docs-only decision-record work, run at least `bun run decision:check`, `bun run doc:check`, `bun run format:check`, and `git diff --check`. For skill changes, also run `bun run skill:check`. Select any other evidence from the outgoing diff; the pre-push hook contributes typecheck, lint, and monorepo checks.

When opening or updating a PR, summarize:

- How many decision records and inline notes were added, consolidated, retained as partial supersessions, or archived.
- The main areas surveyed.
- What was intentionally excluded.
- Which checks passed.

For each consolidation group, name the old and current owners, state the evidence for full supersession, and explain why deletion is safe. If an added-then-removed scan finds no qualifying record, report that result and the representative partial cases retained.

Use a draft PR while the survey is still expanding; mark ready only when the candidate set, review responses, and validation are settled.
