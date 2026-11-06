# Decision Record: Preserve Skill selection descriptions

Status: implemented

## Problem

The model's Skill directory keeps only the first line and roughly the first hundred characters of each declared description. Late selection conditions and exclusions disappear before the model chooses a Skill, even though authoring guidance identifies the description as the selection signal. Repeating those conditions in the loaded body cannot repair a decision already made.

## Decision

The `skill` tool renders the complete declared description of every accessible, model-invocable Skill. Whitespace collapses to a single catalog line without dropping semantic content. Existing source order, permission filtering, disabled invocation, loading and reference behavior remain unchanged. No new summary property or replacement cutoff is introduced.

Skill descriptions own the current Skill's purpose, triggers and exclusions. Bodies own execution, subsequent reference or workflow selection, and safety or authorization checks. The reviewed agent-management, tool-design and simplification Skills remove pure self-selection repetition while keeping write confirmation, built-in-source escapes, reference routing and evidence-quality rules. Skill authoring guidance and the canonical reference describe this division.

The obsolete truncation unit and prompt-budget assertions are replaced by a public catalog regression that retains late exclusions and multiline content while exercising normal Skill and reference loading. Other primary prompt checks stay intact. Runtime-context increments and versioned memory contributions from the current development baseline are not changed.

## Alternatives considered

**Move triggers into descriptions but keep truncating them.** Rejected because the visible prefix still drops late exclusions and preserves the original information gap.

**Add a short-summary field or increase the cutoff.** Rejected because a second authoring surface can drift and a larger arbitrary cutoff still discards valid declared routing information.

**Remove all applicability statements from loaded bodies.** Rejected because next-reference selection, execution qualifications and authorization checks can remain unresolved after loading, including explicit user invocation.

## Consequences

The resident Skill directory grows by the previously omitted description content. That cost is not offset automatically by savings in bodies loaded only on demand. Complete descriptions establish information availability, not real-model selection quality; provider evaluation remains separate from deterministic catalog and permission tests. The source manifest's existing validation remains authoritative.
