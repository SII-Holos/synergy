# Decision Record: Continuous reasoning disclosure

Status: implemented

## Problem

A continuous reasoning run can contain multiple provider item IDs. Grouping disclosures by those IDs exposes transport segmentation as repeated Reasoning rows even when no tool or public content interrupts the run.

## Decision

The Web summary projection and shared UI activity projection group adjacent visible reasoning Parts within one assistant message by their position, regardless of provider metadata. The first Part owns the disclosure. Bounded body chunks keep their own bodies and distinct detail regions while sharing expansion state and rendering one leading trigger. Tools, public prose, attachments and assistant messages retain their chronological separation.

This supersedes the grouping condition in [reasoning fragment presentation](2026-10-05-group-continuous-reasoning-item-fragments.md). Its canonical identity and migration rules remain applicable. Provider metadata, stored Parts, paragraphs and model context are unchanged; this presentation change requires no storage migration or API change.

## Alternatives considered

**Keep provider item IDs as disclosure boundaries.** Valid provider segmentation still creates repeated entrances within visually continuous reasoning, and missing identity makes the same problem worse.

**Combine stored reasoning Parts.** This unnecessarily changes stream identity and context reconstruction. Existing summary anchors and disclosure state can express the intended presentation without altering evidence.

**Combine only hydrated Parts.** Virtual body budgets would repeat the entrance as later chunks load. Summary anchors must be computed before chunking and agree with the shared UI projection.

## Consequences

Continuous reasoning has one expandable entrance through streaming growth, absent metadata and virtual body limits. Provider item boundaries remain in the original evidence rather than becoming separate controls. Regression coverage replaces the obsolete provider-boundary assertions, retains content-boundary checks, and verifies paragraph order, keyboard focus, expansion preferences and distinct accessible detail regions through real virtual conversation rendering.
