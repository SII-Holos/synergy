# Decision Record: Viewport reference releases carry element attribution across keyed session swaps

Status: implemented

## Problem

Switching to an already-cached session intermittently opened the conversation at the top with a back-to-bottom button that did nothing.

Runtime instrumentation on the shared auto-scroll hook showed the causal sequence: the session shell (`ShellSurface`) remounts its page subtree keyed by session ID, and Solid mounts the successor viewport before the swapped-out owner's cleanup runs. The old `ConversationViewport`'s cleanup called `setScrollRef(undefined)` unconditionally, clearing the binding the successor had just established. From that moment the page-level `createAutoScroll` instance held no scroller: the initial bottom pin hit the hook's `if (!scroll) return` and was silently swallowed (conversation stays at `scrollTop` 0), and the jump button's `forceScrollToBottom()` hit the same guard (dead button). One lost reference produced both symptoms.

The defect only fired when the target session's message window was already cached: a cached switch mounts the successor viewport immediately alongside the old owner, while an uncached target first swaps in the loading view, letting the old viewport clean up with no concurrent successor. That cache dependence produced the "sometimes" character; a back-and-forth switch between two visited sessions reproduced it on every pass.

## Decision

Reference releases are attributed: a viewport releases exactly the element it bound, and holders only honor a release that still owns the current binding.

- `createAutoScroll.scrollRef` / `contentRef` accept an optional `releaseOf` element; a release whose `releaseOf` no longer matches the held binding is ignored. Unattributed releases (no `releaseOf`) keep the previous clear semantics so existing callers are unaffected.
- `ConversationViewport` records the scroll and content elements it bound and releases them with attribution from its cleanup.
- The session page's `setScrollRef` applies the same guard to its own scroller copy before forwarding to the hook; the plugin conversation binding (`bindPluginConversation`) tracks the element behind each `access.own` release closure and forwards attribution both ways, so permission-recycled releases cannot drop a successor binding either. Kanban panes forward the release argument to the hook.
- The plugin conversation contract (`PluginConversationViewport.contentRef`, `PluginConversationService.setScrollRef`) widens its signatures with the optional release element — an additive change within UI API 5; no plugin code passes it today.

## Alternatives considered

**Ignore all ref-cleanup releases and rely on binding only.** A release is also the only signal that the last viewport unmounted without a successor (for example, the conversation view temporarily swapped out for a loading state); ignoring releases would leave the hook pinned to a detached element until the next bind, re-introducing a stale-element class of bugs. Lost.

**Re-bind on a microtask after cleanup.** Solid guarantees no ordering contract between the successor's bind and the owner's cleanup across keyed swaps, so any timer-based repair is a race with the next switch. Attributed releases make the ordering irrelevant instead of compensating for it. Lost.

**Stop keying the shell subtree by session ID.** The remount is what gives each session a clean viewport/composer/decision-stack state; removing it to avoid one clobber would trade an architectural boundary for a symptom. Lost.

## Consequences

- The successor viewport's binding survives the stale owner's cleanup, so the initial pin and the jump button keep operating on a live scroller on every switch path.
- Attribution is a naming convention at the release boundary, not an enforcement: an unattributed release still clears (legacy callers), so future viewports must pass the bound element to keep the guarantee. The shared viewport and the plugin binding layer are the only release sites and both do.
- Regression tests cover the keyed-swap sequence for both scroller and content bindings, including that a stale release leaves the successor's forced pin working while an owning release still clears. Plugin binding tests cover same-surface replacement, stale component cleanup, cross-surface disposal, rejected rebinding after disposal and exactly-once release.
