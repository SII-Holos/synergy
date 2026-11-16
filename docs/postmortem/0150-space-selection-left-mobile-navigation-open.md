# Space selection left mobile navigation open

## Executive summary

Switching from an organization to Personal space on a phone restored the original draft behind a modal navigation drawer. The Space menu changed routes but did not notify its mobile shell to close. Space selection now completes the existing drawer close action, and combined acceptance verifies that the restored composer is directly operable.

## Summary

The combined App test verified retained draft and attachment values after a three-space round trip. Screenshot review showed the drawer covering that restored state. The values existed in the DOM, but their presence alone did not prove that the user could continue editing.

## Timeline

1. Seven combined browser cases passed their original data and identity assertions. The first mobile restoration screenshot still showed navigation over the composer.
2. The same immutable captured App bundle reproduced the sequence. Waiting five seconds for Navigation to close failed; its dialog remained expanded. This was distinct from a transition captured too early.
3. Adjacent Home, recent-session, destination and panel navigation actions all called the existing drawer close owner. SpaceSwitcher changed the selected Space without a corresponding callback.
4. SpaceSwitcher gained an optional navigation callback, supplied by MobileDrawer. The permanent combined case requires the dialog to disappear and the original composer to accept a real click, while retaining its draft and attachment.

## Root cause

The Space menu owned destination selection but lacked a completion callback for the mobile presentation that hosted it. Tests asserted restored values without asserting that the modal layer had retired, allowing a blocked destination to satisfy the restoration check.

## Guardrails

- [x] Machine check: `apps/web/test/context/space-combined.browser.test.ts` waits for Navigation to close after selecting a Space and focuses the restored original composer through a real click.
- [x] Machine check: the same full-App round trip preserves Personal, A and B drafts, the personal attachment and the desktop resource tab without adding a mobile panel launcher.
- [x] Owning decision: [mobile Space navigation completion](../decisions/implemented/bug-fix/2026-11-12-close-mobile-navigation-after-space-selection.md) keeps route and shell ownership separate.

## Lessons

Restored DOM values do not establish a usable destination. Verify the modal lifecycle and an actual user interaction after navigation, alongside the retained data.
