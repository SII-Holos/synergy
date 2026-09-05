# Decision Record: Adopt staged frontend redesign

Status: implemented

## Problem

Synergy has a broad frontend surface with shared UI components, application shell components, workbench panels, plugin contributions, and desktop-hosted surfaces. A single visual rewrite would make it difficult to identify whether a regression came from a theme token, shared component, page composition, or product interaction change.

The redesign also needs to preserve existing data, route, plugin, localization, accessibility, and runtime contracts while making visual decisions reviewable and independently reversible.

## Decision

The frontend redesign is delivered as a sequence of focused pull requests rather than a single visual rewrite. The sequence starts with a review baseline, then changes shared surface and typography rules, then updates the application shell, session reading flow, composer, workspace surfaces, and accessibility details.

Each pull request keeps its behavioral scope narrow, includes light and dark visual evidence, preserves existing data and route contracts, and runs the narrowest relevant UI tests before broader package validation.

The first implementation work prioritizes surface hierarchy, spacing, and state language before brand color changes because those changes address the largest cross-page inconsistencies without discarding the existing semantic theme contract.

## Alternatives considered

### One large redesign pull request

Rejected because it combines unrelated visual and interaction decisions, produces an oversized review surface, and makes rollback or bisection difficult.

### New UI framework or component library

Rejected because the repository already owns a shared Solid UI component layer, semantic theme tokens, accessibility conventions, and generated theme artifacts. Introducing another system would increase visual and behavioral divergence.

### Palette-first redesign

Rejected because color changes cannot resolve overloaded navigation, nested surfaces, unclear state priority, or crowded composer controls.

## Consequences

The redesign takes longer to complete but each step remains reviewable, testable, and independently revertible. The repository gains a stable screenshot and interaction baseline for comparing later changes.

The PR sequence introduces temporary intermediate states: shared primitives may improve before all pages adopt them, and some visual inconsistencies may remain until the relevant page PR lands. The active installed Synergy runtime remains untouched while source changes are developed and verified in an isolated instance.

## PR sequence

1. Baseline and screenshot matrix.
2. Surface hierarchy and border policy.
3. Typography, spacing, and control dimensions.
4. Shared state language.
5. Application shell and sidebar navigation.
6. Session reading flow and activity hierarchy.
7. Composer progressive disclosure and execution states.
8. Session header and top-bar simplification.
9. Notes, Blueprints, and Workbench alignment.
10. Settings, Marketplace, and plugin-surface alignment.
11. Motion, responsive behavior, keyboard focus, and accessibility closeout.

## Verification contract

UI changes must preserve light and dark themes, same-mode theme switches, keyboard focus, narrow layouts, loading and empty states, errors, permissions, reduced motion, localization contracts, and plugin lifecycle behavior. No pull request may restart or modify the user's active Synergy runtime.
