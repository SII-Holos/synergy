# Decision Record: Tool action description preference

Status: implemented

## Problem

Action-and-target labels identify a file, command or query, but can omit the reason an agent chose that operation. Calls already retain this purpose in `workBrief`, and readers need a way to prioritize it without losing the existing target-oriented presentation.

## Decision

General settings exposes **Prefer action descriptions**, backed by the optional `preferWorkBrief` boolean in the Workbench configuration domain. It defaults to false. When enabled, shared tool rows use trimmed, non-empty recorded intent for visible labels, hover text and accessible names. Missing or blank intent preserves the existing label selection. Session and Kanban views forward the preference independently of process disclosure and reasoning preview. The public conversation service exposes it through an optional accessor with the same default.

Switching the preference preserves call identities, result opening, status, focus and mounted row owners. Canonical Parts, model instructions, business inputs and permissions are unchanged. No additional model call or generated summary is involved.

Targeted configuration refresh reconciles the global preference snapshot alongside retained Scope snapshots. Kanban consumes the global store, so refreshing only Scope stores leaves its labels stale after a successful settings save. Both stores use the existing Core bootstrap request; the global refresh does not depend on an active Home Scope lease.

## Alternatives considered

**Always prioritize intent.** This removes the established target-oriented presentation for readers who prefer exact paths and commands.

**Tie intent labels to activity display mode.** Disclosure density and label content answer separate preferences; coupling them prevents selecting either independently.

## Consequences

Readers can choose purpose-oriented labels while older calls remain readable. The preference adds one setting and must be forwarded through the Scope bootstrap, public conversation service and all built-in conversation surfaces. Intent is an agent-authored description of purpose, not proof of a successful outcome; existing status indicators remain authoritative.

Behavior coverage extends the settings patch tests and real SessionTurn fixture to cover both toggle directions, all display modes, absent and blank intent, accessible failures, retained rows and unchanged result targets.

The mounted GlobalSync regression also changes the saved preference in both directions, with and without a retained Home Scope, and checks reactive global consumers and the Scope snapshot. Integrated browser acceptance saves the setting while Kanban is mounted and verifies that labels update without a page reload.
