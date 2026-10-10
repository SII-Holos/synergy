# Decision Record: Native Space layout arbitration

Status: implemented

## Problem

A native Space page scroll can remain at its first small displacement while body mutation and resize observers run. The shared process viewport permits anchor restoration whenever the current offset equals the last delivered offset, even though the browser has not completed paging. A DOM compensation or the App's virtualizer-backed restoration can therefore write during native animation. Displacement equality is not evidence that paging has finished.

## Decision

The shared process viewport defers body-layout restoration for uncancelled trusted Space and Shift+Space input with available scroll range until native `scrollend`. Ctrl, Meta and Alt combinations are excluded because Chromium's [default Space handler](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/input/keyboard_event_manager.cc) does not page for those modifiers. Available range uses the shared one-pixel alignment tolerance because scroll offsets can be fractional while height properties are rounded. During deferred layout, subsequent scroll receipts advance the captured offset and subtract their displacement from the saved anchor offset without recapturing layout-shifted content. Completion reconciles the actual viewport offset against the last receipt before releasing paging ownership and restoring that adjusted anchor through the existing restoration callback: `scrollend` can arrive before the terminal `scroll` receipt. After restoration and measurement settle, the owner captures the final visible anchor so later growth between the old and new reading targets remains protected. New reading interactions, explicit following and disposal cancel this handoff with the existing restoration frames. Wheel input and its accepted compensation policy remain unchanged.

The focused DOM regression uses real Chromium Space input and preceding character-data growth after its first scroll receipt. It positions detached reading and verifies available range before input, requires no script `scrollTop` write before the first real `scrollend`, more than 100 pixels of native displacement, real height growth and completion-time compensation that preserves the measured native delta within one pixel. It then grows content between the original and final visible anchors and requires the final paragraph to remain within one pixel. The fixed observation budget is 12 pairs of animation frames under the same CPU throttling as the Web Space regression. Fractional zoomed geometry verifies boundary Space produces no native displacement while later growth still restores reading; cancelled trusted Space and Ctrl, Meta or Alt combinations have the same recovery guarantee. The three modifier controls failed with 480 pixels of reading displacement before admission excluded them. The Web regression arms evidence growth only after keydown so preceding locator measurement cannot consume its one-shot scroll listener. Its original displacement threshold, observation budget, focus, range and evidence assertions remain intact.

The same DOM regression also withholds subsequent native scroll receipts after more than 100 pixels of delivered movement, while preserving real Space input, growth, `scrollend`, compensation and the fixed observation budget. This control rejects reliance on a terminal scroll receipt independently of platform event ordering. Native completion reconciles only the undelivered delta; already delivered movement is not counted twice.

## Alternatives considered

**Restore whenever the delivered offset is unchanged.** A throttled first scroll receipt and the following restoration frame can observe the same offset while native animation remains active. A compensation write is still premature.

**Release movement on its first scroll receipt or after a frame budget.** Neither event means that the browser has finished paging. Native `scrollend` supplies completion without a timing estimate.

**Discard every layout change during paging.** This avoids competing writes but loses reading compensation for actual growth above the reader. Carrying displacement into the retained anchor preserves both input and eventual layout correction.

**Apply the new deferral to every input kind.** Wheel compensation before a missing or suppressed `scrollend` already has a distinct regression. Limiting deferral to real Space paging avoids changing that accepted behavior or synthetic event fixtures.

**Keep the original anchor after compensation or assume integer boundaries.** Deferred displacement needs the old target until compensation settles, but subsequent reading needs the final visible target. Keeping the old target moved the actual paragraph by 384 pixels during intermediate growth. Strict boundary comparison deferred a stationary Space at a rounded 0.6-pixel remainder and allowed 690 pixels of later reading displacement. The corresponding real browser regressions reject both behaviors.

## Consequences

Body growth can remain uncompensated while native Space is moving, then settle after completion. The native animation owns its interval instead of sharing it with imperative anchor writes. The shared owner changes; the App adapter and virtualizer library do not gain another input classifier or restoration loop. Available range prevents stationary boundary Space input from leaving an indefinitely deferred layout. Local macOS and Linux Chromium traces and focused regressions establish write ordering and terminal-displacement accounting; exact published-head CI remains a separate verification requirement.
