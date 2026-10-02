# Decision Record: Upgrade primary identities through their data owners

Status: implemented

## Problem

Primary agent names also identify persisted configuration, conversation execution, workflows, scheduled tasks and usage attribution. A display-only rename leaves old execution references behind. Aliases obscure the current execution contract, while global text replacement changes historical evidence.

## Decision

The responsibility catalog selects Atlas, Forge and Pico for general, coding and lightweight work. Registration, prompts, workflow rules and built-in behavior tests select these responsibilities. The API continues to expose `Agent.name` as the runtime identity. Web uses the resolved configuration and visible primary catalog for defaults, and its existing presentation map for labels and styling.

Each data owner registers a versioned migration for its structured references. A separate frozen historical mapping makes upgrade behavior independent of future catalog edits. Owner migrations expose reusable configuration and record transforms; central import entry points order them through the same migration graph before validation or publication. Newly discovered project configurations use this entry point. Home merges invalidate Note metadata indexes through Note's public service. Raw usage records stay immutable while query grouping and agent filtering associate historical identities.

Execution accepts current names only. Product identifiers, models, permissions, tools, delegation and internal agents keep their contracts. Custom-name conflict detection is outside this change.

## Alternatives considered

**Retain execution aliases indefinitely.** This spreads compatibility into live selection and makes accidental old invocations succeed. Compatibility belongs to owned persisted-data upgrades.

**Replace all matching text.** This corrupts prompt bodies, message contents, external identities and historical billing or experiment evidence.

**Run only a one-time startup migration.** An already upgraded Home can discover an old project or import old data later. Reusable owner transforms cover these boundaries without startup backfills.

## Consequences

Upgrade retry and continuation remain explicit owner responsibilities. Tests cover fresh registration, old execution rejection, configuration comments and Markdown, queued input, stored Session delegation rules, restart, late project discovery, cross-domain imports, scheduled trigger matching and historical usage attribution.

The [test fixture decision](../../implemented/simplification/2026-10-02-primary-agent-identities-and-test-fixtures.md) also removes duplicate lightweight registration checks, metadata-only folded-tool checks, hand-reconstructed visibility checks, unused catalog reconstruction and repeated waiting prose assertions. Registration stays covered by one parameterized identity contract. Real tool exposure covers all seven folded tools, and independent permission, hidden reviewer, complete catalog, cancellation, continuation and byte-budget tests remain.

The Light Loop and Lattice wrapper suites combine three repeated byte-exact identity snapshots into request-boundary and workflow-instruction checks across primary responsibilities and a synthetic agent. Full system rendering, empty-input handling and prompt-size budgets remain covered. Configuration upgrades preserve delegation-rule order and attached JSONC comments, and command names remain unchanged.
