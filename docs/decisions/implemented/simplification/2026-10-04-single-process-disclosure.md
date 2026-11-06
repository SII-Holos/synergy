# Decision Record: One conversation process disclosure

Status: implemented

## Problem

Expanding a completed turn reveals another closed action-count control. Users must activate two controls to inspect one process, and repeated reasoning arrows compete with the readable history.

## Decision

The turn-level process control owns visibility of its logical activity windows. Action counts inside the process are static metadata; opening the process exposes tool rows and event entries directly. The existing bounded internal scroll, virtualized bodies, reading anchors, full-history locator and final-answer identity remain intact. A viewport hidden by its enclosing exit retains its last visible offset and Part anchor instead of saving the hidden element’s zero geometry. Full, Balanced and Minimal retain their turn-level defaults and explicit user overrides. Per-block disclosure values do not control the rendered windows.

Reasoning remains independently expandable. Its secondary arrow appears on hover, keyboard focus or expansion for a fine pointer and remains visible on touch. The native trigger, accessible name, expanded state and focus indicator remain available. Ordinary tool rows retain their direct Execution details action.

## Alternatives considered

Automatically opening a second disclosure after the main control retains two competing owners and still adds an unnecessary tab stop. Removing the internal viewport exposes long tool histories to the outer conversation and conflicts with the retained reading model.

## Consequences

One activation reveals the process; users cannot independently collapse its action-count groups. Each group retains bounded rendering and its internal reading position. Browser tests cover one-step keyboard activation, hover/focus/touch affordances, collapse/reopen, history location, compaction, child results and mounted-content bounds.

This refines the disclosure hierarchy in [conversation process presentation](../feature/2026-10-01-conversation-process-presentation.md).
