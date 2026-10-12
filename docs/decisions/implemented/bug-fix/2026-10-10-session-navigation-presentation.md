# Decision Record: Session navigation presentation

Status: implemented

## Problem

A Home Session with an unloaded message bucket could be classified as a new task. Navigation briefly mounted the retired greeting before history arrived. Retaining the outgoing transcript while fading in a transparent incoming transcript also painted unrelated messages over one another. Tests checked waiting and final states but omitted the admission frame.

## Decision

The new-task predicate uses route and captured-submission identity, never an empty message bucket. Existing Sessions use the conversation loader's explicit pending, empty and error states. The games-enabled and plain introductions reuse one welcome heading; the retired branding and heading styles are removed.

The no-greeting and no-overlapping-transcript invariants remain. [Retained Session views and projected updates](../architecture/2026-10-12-frontend-residency-projections.md) supersedes the transient outgoing DOM copy: warm navigation exposes its existing view, while cold navigation exposes the target shell and local placeholders immediately. There is no clone capture whose timing can race a preparation render effect. A terminal preparation error remains actionable without hiding the Composer.

## Alternatives considered

**Wait for message loading before deciding whether to show the greeting.** A confirmed empty existing Session is still an existing Session; data readiness cannot determine new-task intent.

**Fade out the old transcript before fading in the new one.** This prevents overlap but introduces a blank interval and extra delay after the target is ready. An atomic handoff keeps text readable throughout preparation and admission.

**Cover the old transcript with a background during the incoming fade.** A second painted surface retains unnecessary animation and theme ownership. Releasing the obsolete picture before showing the target is simpler and preserves transparent descendants without text blending.

## Consequences

Session switching has no decorative transcript fade, including in reduced-motion mode. Welcome games, new-message arrival and disclosure motion retain their existing owners. Browser regression tests hold real Home history pending, distinguish empty Sessions from new tasks, and inspect admission alongside rapid replacement, Scope changes and reduced motion. Tests assert visible-state invariants rather than machine-dependent switching deadlines.
