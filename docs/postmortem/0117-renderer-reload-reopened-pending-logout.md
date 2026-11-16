# Renderer reload reopened pending logout

## Executive summary

The organization UI blocked a connection before Main durably recorded logout. Reloading during local cleanup then restored Main's ready descriptor. Persisting the original connection intent before that interval and requiring revision-bound prepare/commit phases closes the reload gap without letting delayed logout revoke a later login.

## Summary

An isolated App fixture found the issue while checking the Chinese narrow-screen logout flow. The pending heading was an optimistic renderer observation. It could appear before Main had received the action, so a new document could reopen the account. No copied user Home or active application was started or modified.

## Timeline

1. The real App initiated logout and displayed its pending heading while Main's descriptor remained ready.
2. Reload accepted that descriptor, exposing ready organization navigation instead of pending recovery.
3. Main account fixtures reproduced unconditional revocation during prepare, acceptance of an arbitrary pending nonce and stale selectors after refresh.
4. Revision-bound Main preparation and a durable point intent made reload retain the same request. A further two-window fixture found that the second recovery misclassified an already removed final intent; explicit missing-record idempotence fixed it without deleting a replacement.
5. Native account/IPC tests, connection tests, actual IndexedDB transactions and the App reload path passed. Styled public assets were also included so final layout screenshots used the real product mark.

## Root cause

The renderer treated temporary local state as durable native acceptance. Main's connection identifier established the account but did not distinguish successive logins or refreshes. Controlled-cache cleanup introduced an asynchronous interval between the visible state change and native persistence, and local state disappeared with the document.

## Guardrails

- [x] Machine check: `apps/web/test/organization/space.browser.test.ts` — `reloading before Main accepts logout retains the same durable cleanup intent`.
- [x] Machine check: `apps/web/test/organization/sign-out-store.browser.test.ts` — actual concurrent IndexedDB transactions preserve the first owner and reject deletion of its replacement.
- [x] Machine check: `apps/desktop/test/organization-accounts.test.ts` — durable preparation, restart, refresh conflict, later login and legacy pending revision recovery.
- [x] Machine check: `packages/organization-protocol/test/desktop.test.ts` — old phase-less requests and mismatched commit revisions are rejected.

The [decision](../decisions/implemented/bug-fix/2026-11-12-recover-native-logout-before-renderer-reload.md) defines recovery ownership. The frontend Skill requires reload checks before request arrival and after native receipts, including concurrent windows and later login.

## Lessons

Test the receipt interval that actually grants recovery authority. A pending label is insufficient evidence that another process has accepted the action. Recovery metadata must survive the cleanup it coordinates and must remain bound to the original authority.
