# Markdown terminal estimates lost reading

## Executive summary

Large streamed answers replaced their mounted DOM with an unmeasured virtual document. Default row estimates admitted the wrong range, losing the paragraph being read through repeated paint frames. Existing tests checked terminal DOM bounds and copying after settlement, so they missed the transition. Reading continuity requires canonical source identity and measured initialization across renderer ownership.

## Summary

A synthetic answer of 180 paragraphs exceeded the terminal document threshold. After a native wheel gesture in the middle of the answer, 86 of 90 sampled animation frames could not find the paragraph that had been visible. The terminal virtualizer eventually settled near the end of the answer. A separate stream probe produced 2,800 settled Text nodes from 2,800 one-character updates.

Combined conversation acceptance exposed another 32-pixel drift: capture chose source position zero instead of the first visible source position. A horizontal overflow ancestor reported computed vertical `auto` despite having no vertical overflow. A focused reproduction drifted 59 pixels, while an initially empty vertical viewport later mounted all 125 document blocks under the wrong scroll owner.

## Timeline

The October 8 audit first reproduced the missing reading paragraph through actual Chromium paint frames. Parser-consumption regressions then exposed raw URL replay, multiline inline code and normalized indentation errors in an external position estimate. Replacing that estimate with parser-owned provenance revealed the settled Text growth. A platform-workload regression reproduced more than 104 million segmented characters after appending only 100 characters to a settled one-MiB prefix.

## Root cause

The worker and incremental renderer had no shared reading identity or measurement transfer. Replacing DOM forced an empty layout that clamped native scroll position, while Virtua began from generic estimates and waited for a later scroll event instead of reading the existing offset. Block starts could not preserve reading through changed paragraph wrapping, code chrome, repeated table headers or media layout. A caller-side character counter could not describe internal pending-token replay. Streaming text appended separate nodes, and coalescing them exposed a whole-paragraph grapheme scan on each delta.

Separate ancestor scans treated computed `overflow-y` as vertical scroll intent. CSS cross-axis normalization made that value ambiguous, and checking only current overflow would also lose an empty declared viewport before its document arrived. Both renderers require the same explicit native owner, with actual overflow detection reserved for undeclared containers.

Suppressing unchanged-offset scroll delivery also removed a public pagination callback. Searching a large execution record left one short tail row; the browser clamped its attempted scroll to zero, and earlier content never loaded. Scroll direction must ignore zero movement while public range-admission callbacks remain available.

CI also exposed a development-fixture reload during locale and theme checks. The current import graph repeatedly lost its HMR connection after several navigations, causing Vite to reload the page; paired base-source runs passed. The static fixture uses production build and preview because it tests product behavior, retaining all assertions and action timeouts without retries. Disabling server HMR alone still loaded the development client and reproduced the reload.

## Guardrails added

[Markdown terminal reading](../decisions/implemented/bug-fix/2026-10-08-markdown-terminal-reading-and-stream-ownership.md) records the canonical reading point, synchronous measured handoff and rejected alternatives. [Paint-frame regressions](../../packages/ui/test/markdown-virtual.browser.test.ts) retain the reading paragraph across real worker completion. [Consumed-source tests](../../packages/ui/test/markdown-stream-provenance.test.ts) exercise both parser artifacts. [Stream regressions](../../packages/ui/test/markdown-stream.test.ts) count settled nodes, retain selection endpoints and measure segmentation input after a large prefix. [The frontend Skill](../../.synergy/skill/develop-frontend/SKILL.md) requires these ownership and workload checks.

## Lessons

Eventual terminal correctness and small mounted-row counts do not prove reading continuity. An incremental renderer must account for update count as well as source length. Source identity belongs to the parser that consumes it, and geometry belongs to the virtualizer that places it.
