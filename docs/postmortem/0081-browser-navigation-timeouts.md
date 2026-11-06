# Browser navigation timeouts interrupted usable pages

## Executive summary

Human website opening shared an automation command deadline and could expose a preparation screen followed by a blank tab. A CDP timeout was treated as page failure despite leaving the action outcome unknown. Separate native human dispatch, document progress and confirmed renderer recovery prevent a slow response from destroying usable page state.

## Summary

The reported symptom was `Page.navigate` exceeding ten seconds during Desktop link opening. The screenshot establishes the command timeout, but cannot distinguish website latency, a stalled renderer or transport delay in that particular occurrence. Source tracing establishes that the human navigation path awaited CDP and that timeout recovery could replace the native generation.

## Timeline

On 2026-10-19, source tracing separated preparation, native page creation and navigation. Behavioral tests reproduced pending-link blank presentation and timeout recovery. Actual Electron acceptance then exercised a website response delayed beyond ten seconds and an injected unresolved CDP command while retaining an unsaved form.

During acceptance, a screenshot also showed a native white rectangle over the chat after shell navigation. A real Electron regression reproduced the old view remaining in the window after its renderer document had been replaced. Frame sampling separately exposed a New tab title because catalog-to-tab synchronization omitted navigation metadata.

Follow-up acceptance found three additional gaps: a warm link waited for another native capability query before replacing the old address, initialization failure returned before its WebContents finished closing, and a separate unversioned error event could arrive after a newer navigation. Hidden-window Electron and rendered behavioral regressions reproduced these failures before their fixes.

Tracing stop end to end found that the server queue still held human controls behind Agent work even though the Desktop queue supported interruption. A behavioral regression held an Agent operation and showed all five controls waiting; the server interrupt lane released them while preserving ordinary command and disposal ordering.

Repeating acceptance with a newer complete Desktop bundle exposed an installation failure before server readiness. The upgrade owner's duplicated first-party list omitted Desktop's separately selected Browser runtime, leaving that root at the old host version. The bundled seed could not satisfy it, so startup attempted registry resolution. Deriving upgrade ownership from the preset catalog lets compatible Desktop selections advance offline; the regression retains third-party constraints and old generation pins.

After that correction, the real bundled upgrade exposed a second pre-bootstrap boundary: copying and verifying the complete module tree exceeded the thirty-second unannounced-start deadline. The launcher now reports module preparation before entering the installation owner. The existing bounded stage budget covers this work, while unchanged announcements cannot keep a stalled process alive.

A real-model repeat then showed that a successful stop response could arrive only after the wait deadline. The control itself was fast, but its preceding catalog request waited on a synthetic Scope Workspace lock. Queue tests had replaced that boundary with an immediate adapter. Scope pages now avoid the synthetic lock, while bound-page interrupts reuse the active binding and repeat validation. New regressions retain the actual owner and Workspace lock.

## Root cause

Command acknowledgement, document loading and renderer health had different meanings but shared failure handling. Extending the deadline alone would retain that ambiguity. Independently, pending presentation could use an empty canonical page URL before the requested destination had committed, rendering a new-tab interface between the click and website.

Native view cleanup depended on renderer component disposal, which is not guaranteed during document replacement or renderer failure. The main process did not release that presentation when the owning shell disappeared. Renderer-only screenshots did not establish whether a native overlay remained attached.

## Guardrails

Protocol v8 exposes ordered transient navigation state. Human WebContents navigation acknowledges dispatch without awaiting page load; CDP timeouts retain structured unknown-outcome data. Only actual renderer exit triggers bounded native generation recovery. Pending links retain their requested address and one tab identity. Regression tests cover late and superseded events, main-frame errors, stop, slow load and form preservation.

The native presentation manager releases attachments on full shell navigation and shell renderer loss without destroying website contents. A native fixture checks parent membership, same-document routing, reattachment and retained form state; the rendered catalog test checks the requested title before commit.

Prepare read-only presentation capability ahead of clicks, keyed by bridge, server and capability selection; actual page tickets and command authorization remain fresh. Await bounded native cleanup before returning initialization failure. Carry navigation identity with errors and discard superseded results. User navigation and stop cancel pending Agent waits without replaying operations whose effect is unknown.

## Lessons

A command timeout does not prove an effect failed or that its renderer crashed. User-visible progress must describe the requested navigation throughout preparation. The [implemented decision](../decisions/implemented/architecture/2026-10-19-native-browser-navigation.md) records the recovery policy and alternatives.
