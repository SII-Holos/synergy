# Decision Record: Use short playable challenges in task introductions

Status: implemented

## Problem

A task introduction has little time to explain an interaction. Multi-tool simulations and authored stories require users to learn controls or read context before receiving meaningful feedback. Short challenges need a clear first action, a visible result and a low-cost retry.

## Decision

Three independent local models provide chain reactions, timed block stacking and gravity-assisted delivery. Each model has deterministic initialization and explicit success, failure and restart transitions. Their rules remain independent of rendering and message drafts. Chain reactions propagate through nearby moving particles; stacking preserves only overlapping support; delivery integrates gravity at a fixed timestep and checks destination, obstacle and playfield collisions. All moving collections and flight traces are bounded.

The models use familiar interaction families with locally authored layouts and visual feedback. The one-click chain-reaction reference is [Boomshine by K2xL](https://www.k2xl.com/games/boomshine/); the alignment-and-height reference is [Stack by KCHLAB](https://www.kchlab.com/). No source code or game assets are incorporated from these references. The stable assignment and draft ownership rules remain in [interactive task introductions](2026-10-02-interactive-task-welcome.md).

## Alternatives considered

**Multi-tool world simulations.** They make the user learn several controls before reaching the first result.

**Only classic arcade games.** A varied selection of timing, aiming and chain-reaction challenges better demonstrates how a small change in rules changes the experience.

**A shared game engine.** These bounded models need no scene graph, general physics package or shared rules interpreter; each owns its mechanics and tests.

## Consequences

Pure behavioral tests verify propagation, support loss, collision, reachable destinations and restart. A fixed timestep keeps trajectory preview and flight consistent. These are local interactive examples, not model-generated work or persisted sessions.
