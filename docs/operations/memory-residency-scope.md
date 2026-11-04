# Memory residency scope

Review globs for frontend memory admission. They do not change runtime behavior. Oxlint enforces the boundary and hot globs; retain is review-only.

## Retain

Long-lived client stores. Keep eviction, caps, and owner disposal when editing them.

- `apps/web/src/context/session-message-window.ts`
- `apps/web/src/context/message-eviction.ts`
- `apps/web/src/context/part-content-store.ts`
- `apps/web/src/context/scope-retention.ts`
- `apps/web/src/context/view-residency.tsx`
- `apps/web/src/context/conversation-content-state.ts`
- `apps/web/src/context/resource-preview-cache.ts`

## Boundary

Code that admits server pages, snapshots, or events into those stores. The boundary override forbids `structuredClone()` and an unbounded `session.messages()` read.

- `apps/web/src/context/{sync,global-sync}.tsx`
- `apps/web/src/context/{event-queue,session-message-page,session-message-loader,session-message-page-recovery,session-sync-plan,scope-snapshot-merge,part-checkpoint-merge,part-page-batch,part-summary-loader}.ts`

## Hot

Per-token, per-frame, or per-row updates. The hot override forbids `structuredClone()`.

- `apps/web/src/context/{streaming-token-event,message-arrival,part-arrival}.ts`
- `apps/web/src/components/session/{conversation-rows,virtual-conversation-rows,conversation-timeline,conversation-viewport}.{ts,tsx}`

## Lint

`memory-residency/no-restricted-syntax` is set in [oxlintrc.json](../../oxlintrc.json) and run by [memory-residency.js](../../script/oxlint/memory-residency.js). Oxlint has no native `eslint/no-restricted-syntax`.

- Boundary and hot: `CallExpression[callee.name='structuredClone']`.
- Boundary only: `CallExpression[callee.property.name='messages'][callee.object.property.name='session'], CallExpression[callee.property.name='messages'][callee.object.name='session']`. This matches `client.session.messages()` and `session.messages()`. Explicit full-history UI, including `apps/web/src/components/session/raw-messages-dialog.tsx` and composer submit, stays outside the glob.

The selectors do not restrict `new` or `.map`.

Verify with `bun run lint` and `bun test --config /dev/null test/script/memory-residency-lint.test.ts`.
