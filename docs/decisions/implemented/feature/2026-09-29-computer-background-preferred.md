# Decision Record: Background-preferred native Computer Use

Status: implemented

## Problem

A blanket prohibition on activation excluded useful Cua input routes and made canvas actions unreliable. Requiring an AX window to establish any identity also disabled otherwise valid screenshots. The public action set omitted targeted text, shortcuts, dragging and semantic value changes, while its separate point command duplicated coordinate admission.

## Decision

Keep the pinned Cua 0.30.4 SDK and private macOS worker. The agent uses one loop: find window, observe, act, observe to confirm. Background is the default; `foreground:true` explicitly selects Cua's foreground route without a per-action approval dialog. Foreground observation uses `bring_to_front` and leaves the selected window in front. Actions reuse Cua's input and focus-restoration implementations. No failed mutation is automatically replayed or escalated.

Expose click, targeted type, key/modifiers, scroll, drag and semantic set_value through one action tool. Every coordinate shares the exact model-call image receipt and bounds checks; elements carry their snapshot and index. The host transport moves to version 3 and rejects older hosts. Historical output remains readable; the old point executor is removed.

Identity uses process start time and WindowServer ownership independently of optional AX evidence. Captures use the pinned Cua ScreenCaptureKit implementation with exact-window and geometry validation. WindowManager container pairing rejects Stage Manager thumbnails without treating a narrow window as invalid. An observation preserves channel status and capture diagnostics even when both AX and image are unavailable. Foreground observation allows bounded read-only capture retries during window transitions. Observation tokens are one-use and revalidated before dispatch. Foreground activation must not invalidate the coordinate frame. Cua decides whether each selected input route can deliver to the target.

Foreground input briefly excludes other input because it shares physical focus and pointer state. Cua's HID activation also reuses its existing exact-window raise and stable foreground proof: AX focus can identify a covered window before it can receive the first physical click. The original focus-restoration path remains intact. Background operations retain per-process concurrency. Cua's same-process keyboard ambiguity refusal remains intact and maps to background unavailability. Exact AX insertion is validated with a standard editable native text view; it does not establish background support for every text control. Tool output distinguishes dispatch from application completion; cards show the execution mode and retain image evidence with collapsed diagnostics. The existing native and model acceptance scripts use independent application state to check effects.

This supersedes the [strict background restriction](../../archived/bug-fix/2026-09-29-computer-background-focus.md) and the AX-dependent portion of [observation admission](../../archived/bug-fix/2026-09-29-computer-observation-admission.md). The image-delivery and one-use proof requirements remain intact.

Provenance: [Cua source](https://github.com/trycua/cua/tree/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver), [SCK window filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter), and [Backstage's WindowManager pairing evidence](https://github.com/ewiner/backstage/blob/main/Sources/Backstage/WindowEnumerator.swift). Local adaptation: retain Synergy's target, capture and action-admission boundary; reuse Cua acquisition and input instead of introducing another engine. The pairing is an empirically observed macOS behavior, not an Apple API guarantee.

## Alternatives considered

**Prohibit all activation.** This removed necessary input routes and did not meet the requested functional scope. Background preference is explicit without promising universal non-interference.

**Replace Cua or add a second engine.** This would duplicate capture, input, packaging and permission handling. The pinned Cua already provides the needed operations.

**Automatically retry in foreground.** A dispatched but unconfirmed action may already have changed the application. Fresh observation and an explicit subsequent agent choice prevent automatic duplicate side effects.

## Consequences

The API stays small while native validation handles process, window and image details. Foreground input can interrupt the user's desktop by explicit agent choice, and Cua background pointer routes can temporarily affect focus. Applications and macOS versions vary; post-action observation remains necessary. Geometry and receipt validation fail closed instead of guessing coordinates. Physical Intel and mixed-DPI behavior require their own hardware evidence; universal compilation alone does not establish them.
