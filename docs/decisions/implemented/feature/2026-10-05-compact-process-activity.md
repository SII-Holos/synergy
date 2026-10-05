# Decision Record: Compact process titles and conversation spacing

Status: implemented

## Problem

Intermediate prose, tool statistics and reasoning disclosures have different leading and trailing gaps in the shared timeline and virtual conversation. Repeated secondary arrows compete with the outer process entrance. In a long conversation the current runtime label can scroll away, leaving the latest tool summary looking complete while the assistant is waiting for another model response.

## Decision

Use one 8px conversation flow gap for prose, metadata and folded activity summaries in both rendering paths. Virtual tool bodies retain their compact internal row rhythm, and separate user turns retain their existing boundary. Paragraph spacing uses the same flow value. The virtual renderer adds no independent trailing title margin.

The latest active block appends the localized current action to its existing deterministic statistics. Successful counts remain static and retain their identity as activity changes. The action comes from the existing session activity and root execution projection, including submission, approval and question state. Connection loss labels the action as reconnecting. Historical blocks receive no live suffix; completion removes it without waiting for a closing disclosure animation.

Only the current action text receives a slow theme-token highlight sweep when structured runtime evidence belongs to the current root. Approval, questions, reconnecting, stopping, retry and unknown or foreign-root activity remain static. Named recorded operations retain their captions independently of motion eligibility. Reduced motion and forced colors use ordinary readable text. Motion presents the reported runtime state; it does not establish backend progress or completion. No new runtime timer, polling endpoint or persisted state is introduced.

The outer process arrow remains visible. Secondary activity and reasoning arrows reserve their space and fade in on hover or keyboard focus with fine pointers, including when their content is open. Touch keeps arrows visible and uses 44px disclosure targets. Expansion, reading positions and invocation selection retain their existing owners.

## Alternatives considered

**Animate the operation statistics.** Completed facts do not describe the current action and moving every summary would imply multiple active blocks.

**Add a separate live status row below every summary.** It repeats the hierarchy and increases the vertical spacing the compact title is intended to reduce.

**Remove hidden arrows from layout.** Hover would move the title or its target. Opacity preserves the reserved geometry and native button interaction.

## Consequences

The shared UI owns the title status presentation, runtime label and motion eligibility; the App supplies its connection and root context. Existing activity strings and semantic theme tokens cover both appearances. Real-browser tests verify chronological spacing, stable title geometry, keyboard and touch interaction, runtime transitions, reduced motion and terminal removal. Existing process regressions cover disclosure choices, final-answer retention and bounded reading windows. The [Web product contract](../../../../apps/web/PRODUCT.md) and [frontend skill](../../../../.synergy/skill/develop-frontend/SKILL.md) carry the same contract.
