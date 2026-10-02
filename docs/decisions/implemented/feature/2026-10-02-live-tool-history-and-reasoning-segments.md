# Decision Record: Live tool history and reasoning segments

Status: implemented

## Problem

A continuous batch can occupy most of the conversation while the Agent is still working. Treating the tool rendering budget as a batch boundary creates extra process controls with no change in the task. A single undivided reasoning block makes later model replies difficult to locate even when their original parts are retained.

## Decision

The [conversation process presentation](2026-10-01-conversation-process-presentation.md) keeps one ordered batch across adjacent ordinary tool groups until a semantic boundary. Balanced collects completed history behind its successful-operation statistics while the current running calls remain visible. Between tool calls, the latest returned call provides context. Native buttons expose history independently from the current calls; explicit choices retain the App-owned disclosure identity. Stable part keys preserve tool nodes as a call moves into history, and selection continues to open the same invocation in Execution details.

The existing per-group rendering budget bounds a history page rather than splitting the process. Pages retain original order and do not move when new tools arrive. Current calls, detached-reading calls and a focused row stay available outside the selected page. Return to following releases detached retention; user-controlled history disclosure continues to take precedence. Approval and dedicated results keep their existing boundaries and presentation.

One reasoning entrance groups raw parts by assistant reply with numbered headings. Opening moves to the latest segment, and the optional collapsed preview uses that segment's original first line. The shared scrolling controller follows actual content changes, pauses on upward pointer, touch or keyboard reading, and resumes through an explicit Latest reasoning action. No model call produces a reasoning summary. Waiting motion applies to current activity rather than completed statistics, and reduced motion removes it.

The primary Agent prompts and runtime prompt injection share one task-oriented progress instruction: explain the initial useful action, communicate a material finding, changed approach, decision, blocker or prolonged wait, and allow routine tools to continue without filler narration. Injection does not append a second policy to an assembled primary prompt. Conclusions follow actual results. The instruction describes collaboration behavior without explaining rendering or internal event machinery.

## Alternatives considered

**Expand the whole active batch** exposes every completed tool during long tasks and gives process detail more visual weight than the Agent's findings.

**Create a new batch at the rendering limit** bounds one list but invents a task phase, resets statistics and adds disclosures without a content boundary.

**Insert a progress paragraph before every model call** shortens individual lists at the cost of repetitive narration and extra interruptions; a model invocation alone does not establish a meaningful discovery.

**Keep a single undivided reasoning scroll** retains all bytes but leaves later reasoning hard to locate and easy to mistake for missing content.

## Consequences

Long-running tasks show compact completed history and identifiable current activity while preserving inspection, keyboard focus and reading anchors. Full uses the same bounded history pages, so inspecting a very long batch requires page navigation. The presentation adds no API, persistence migration or inference request. Focused behavior tests cover continuous grouping, stable nodes, manual disclosure, detached completion, bounded pages, parallel tools and reasoning following; production Web acceptance remains necessary for visual and streaming behavior.
