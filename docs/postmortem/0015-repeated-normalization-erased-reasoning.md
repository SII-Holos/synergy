# Repeated normalization erased reasoning

## Executive summary

An interleaved-reasoning transform removed reasoning parts after encoding them into provider options. A second pass found no parts and overwrote the encoded reasoning with an empty string. Single-pass tests passed, but the budget and send pipeline applied both passes. Transform tests must exercise composition as well as isolated output.

## Summary

The affected assistant history could retain ordinary text and tool calls while silently losing its reasoning field before dispatch. This changes model context; it does not establish how much any historical score or token total was affected.

## Timeline

- 2026-09-14: Baseline preparation traced provider normalization through budgeting and request preparation.
- 2026-09-14: A repeated-transform regression reproduced the loss. Preserving encoded reasoning made the regression and the full provider-transform test file pass.

## Root cause

The transform treated absence of source reasoning parts as absence of reasoning, although its own previous pass had moved those parts into provider options. Existing assertions checked only the initial transformation and missed that state transition.

## Guardrails added

[Provider transform tests](../../packages/harness/test/provider/transform.test.ts) cover repeated application, explicit empty overrides, and option preservation. [The integration workflow](../../.synergy/skill/integrate-llm/SKILL.md#verify-and-document) requires repeat-normalization checks. [The decision record](../decisions/implemented/bug-fix/2026-09-14-preserve-normalized-reasoning-history.md) records why both pipeline stages retain normalization.

## Lessons

A transform that moves information must recognize its own output. Correct single-pass serialization is insufficient when preparation stages compose.
