# Space-local notification hosts lost background actions

## Executive summary

The App retained background notification sources while its Toast region still belonged to personal Layout. Switching to an organization removed the in-app action surface. The region and notification provider now share the persistent App lifetime, and both Toast and browser activation recheck the original source.

## Summary

The first real App cross-space fixture selected organization B, delivered organization A's valid notice and timed out waiting for Open session. The notice source was subscribed, but the only canonical Toast region had unmounted with personal Layout. A separate DOM fixture held browser permission while retiring the source and demonstrated that the earlier notification implementation could still display it after permission resolved. Another fixture showed a retired click using an old destination.

## Timeline

1. Connection-owned source and typed native transport tests established metadata delivery and retirement independently of selected views.
2. The real App fixture reproduced the missing action after selecting another organization. The canonical Toast region was located inside personal Layout.
3. The region moved beside Space views. The personal GlobalSDK event connection gained presentation leases so an organization view could observe personal completion without retaining personal business content or opening another socket.
4. Browser notification implementation captured an optional activation/current pair and checked it before and after permission, before display and at click. Invalid activation never fell back to an href.
5. The first follow-up browser run proved the personal socket case and the original organization route, but its later menu locator incorrectly assumed that a page header renamed connection metadata. That fixture error was corrected without changing product selection behavior. Toast actions were exercised through their normal hover expansion before screenshots and clicks.
6. Final real App browser cases passed at narrow light and wide dark sizes. Pure lifecycle, personal content-interest, resolver, source replacement and platform DOM tests passed. A real enrolled native Completion also reached the actual Web adapter through authenticated WSS and verified HTTPS.

## Root cause

Source observation, source presentation and click routing had different owners. A surviving source could enqueue a Toast with no mounted region. A pending browser permission request also outlived its original identity, while a raw href did not establish that identity at click time.

## Guardrails

- [x] Machine check: `apps/web/test/organization/notifications.browser.test.ts` switches actual App Spaces before delivery and verifies the original authorized route, retired actions and retained personal socket without body interests.
- [x] Machine check: `apps/web/test/context/notification-platform.dom.test.ts` holds permission across retirement and rejects stale activation without href fallback, preserving legacy callers.
- [x] Machine check: `packages/organization-runtime/test/notifications-http.test.ts` drives the real native producer through authenticated sockets and the actual Web adapter.
- [x] Owning procedure: the frontend Skill requires cross-space source and presentation tests rather than treating a subscribed transport as visible delivery.

## Lessons

Notification presentation must share the lifetime that observes it. An asynchronous permission or metadata result also needs its original source at completion; a destination string alone cannot establish a current account or Runtime. See [notification presentation ownership](../decisions/implemented/architecture/2026-11-12-retain-notification-presentation-outside-space-views.md).
