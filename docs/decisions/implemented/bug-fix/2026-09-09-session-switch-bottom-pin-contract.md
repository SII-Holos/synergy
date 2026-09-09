# Decision Record: Session switch pins to the conversation bottom with an honest jump button

Status: implemented

## Problem

Switching sessions opened the conversation at the top with a probability tied to content and layout timing, and the scroll-to-bottom button could not recover the view.

Four defects compounded on one path:

- The initial bottom pin was a one-shot rAF chain armed once per session. A message-readiness flip cancelled the scheduled chain, but the one-shot guard prevented rescheduling, so the forced pin never ran on the freshly mounted scroller (`scrollTop` 0).
- After the pin landed on partially laid-out content, no follow mechanism was active in an idle session (`working` false, `settling` never opened). Late content growth — markdown images, code highlighting — increased `scrollHeight` without any scroll event, and the scroller's `overflow-anchor` is deliberately disabled, so the viewport drifted upward relative to the content.
- The jump button's visibility was derived only inside the scroll handler. Drift without scroll events never raised the button. When a user scroll did raise it, clicking pinned to the then-current partial layout with no subsequent re-pin, which read as a no-op.
- The `createAutoScroll` instance is created once per page and survives session switches. A previous session's `userScrolled` state disabled non-forced follow in the new session entirely; only the (broken) initial force could clear it.

## Decision

- `createAutoScroll` treats every forced pin as a short follow contract: scheduling a forced pin opens a settle window (default 1000 ms) during which the hook is active, resize-driven content growth re-pins to the bottom, and each such growth extends the window. An upward wheel interaction still releases follow immediately.
- Remounting a scroller element resets the hook's `userScrolled` state, because a fresh scroller always starts at the top; pending frames and settling are cleared so hash-target navigation cannot inherit another session's bottom pin. Ordinary work-completion settling does not extend on growth or shorten an explicit forced-pin window.
- While follow is inactive, content growth reports the bottom distance through a new `onMeasure` callback (rAF-coalesced) so consumers can keep scrolled-up state honest without scroll events.
- The session page re-arms the init chain whenever readiness flips false, gates `onMeasure` until the initial pin has consumed (so partially laid-out content cannot flash the button), and resets `scrolledUp` on session switch. Kanban panes wire `onMeasure` with the same 100 px threshold and no gate, since their panes do not run a loading switch.

## Alternatives considered

**Re-enable native `overflow-anchor` for scroll anchoring.** The browser would compensate top-side growth without any hook code. The hook disables anchoring on purpose: stream appends and turn trimming need deterministic re-pinning, and native anchoring fights the forced pins during exactly the switch path this record fixes. Lost.

**Delay the initial pin until layout is fully stable** (image load events or N stable frames). Unbounded latency: long sessions with remote images could pin seconds late, and no finite frame count covers async media. The rAF pin plus settle re-pin reaches the same end state without gating entry. Lost.

**Keep the jump button purely scroll-derived.** Growth without scroll emits no event, so the button stayed blind to the drift — this was the broken state. Reporting the bottom distance from resize observation is the only signal that sees it. Lost.

## Consequences

- A forced pin now holds for roughly a second instead of jumping once: late layout growth is absorbed, and the user can still wheel up to take over instantly.
- `onMeasure` costs one rAF-throttled measurement per content-growth burst in idle sessions, negligible against the render that caused the growth.
- The re-armed init chain means repeated readiness flapping reruns the chain, but the one-shot guard still deduplicates within a stable ready period, and a consumed pin is not repeated on later flips.
- The settle window is bounded (1 s default), so a pinned idle session does not fight the user after content stabilizes; chronic late growth beyond the window reappears as drift, which `onMeasure` now surfaces through the button instead of hiding.
