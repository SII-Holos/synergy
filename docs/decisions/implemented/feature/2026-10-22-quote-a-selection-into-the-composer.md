# Decision Record: Quote a selection into the Composer

Status: implemented

## Problem

Selecting transcript text did nothing. The host already had a selection signal and a plugin text-action registry, but its only entry point was a right-click menu that appeared only when a plugin had registered an action — so a workspace with no selection plugin installed had no affordance at all. Browsers and Codex both answer this selection with a small inline menu, and readers expect the same here.

The capability readers actually want is narrow: take a passage I just read and put it in front of the model. Sessions, notes and files could already be pulled into a draft as reference chips; text from the conversation itself could not.

## Decision

A quoted passage becomes a fourth Composer reference kind, `QuoteAttachmentPart`, alongside note and session references. It travels the same path as those: a chip in the Composer's attachment strip, removal through the shared `removeAttachment`, the same draft sanitize/merge/equality handling, and one `referenceAttachmentInputPart()` builder that turns every reference kind into the text attachment the model receives. The model sees `<quoted-text role="…">…</quoted-text>` so a quote is distinguishable from surrounding instructions.

The selection surface is now a host surface, not a plugin one. [`SelectionToolbar`](../../../../apps/web/src/components/text-selection/selection-toolbar.tsx) replaces the retired plugin surface and owns presentation for both host and plugin actions: it appears as soon as a reading-surface selection settles, positions above the selection (flipping below near the top edge, clamped to the viewport, a bottom sheet under 640px), and renders Copy, Add to chat, then any registered plugin actions in one flat row. `presentTextActions()` orders them and qualifies a label only when two actions claim the same one, so the retired per-plugin grouping headers do not reappear.

Eligibility is deliberately narrow, in [`selection-dom.ts`](../../../../apps/web/src/components/text-selection/selection-dom.ts): the toolbar opens for message prose, code selections and terminal output, and stays closed for editable surfaces and for unrelated page chrome. Editors keep the native editing menu — quoting the user's own unsent draft is not useful, and a floating toolbar that chases the caret would fight text entry. `canQuoteSelection()` encodes the same rule so Add to chat is never offered for a draft.

The Composer publishes itself through [`quote-target.ts`](../../../../apps/web/src/components/prompt-input/quote-target.ts). Because retained session views keep inactive composers mounted but hidden, the target is any registered Composer that reports itself available — availability includes the active view — rather than whichever registered last.

Sent messages render the quote through the existing special-attachment card as `kind: "quote"`, labelled with the quoted text and the `message-part.quote-label` descriptor, so the chip that entered the draft and the chip in the transcript are the same object seen twice.

Copy goes through the shared clipboard contract, not `navigator.clipboard` directly. [`SelectionToolbar`](../../../../apps/web/src/components/text-selection/selection-toolbar.tsx) calls [`copyTextToClipboard()`](../../../../packages/ui/src/components/clipboard-core.ts) directly, which tries the Desktop `platform.clipboard.writeText` bridge, then the async Clipboard API, then a hidden-textarea `execCommand("copy")`. Reaching for the Clipboard API alone is not enough for two independent reasons: the Desktop shell denies every permission except microphone-only capture in [`security.ts`](../../../../apps/desktop/src/security.ts), and an unfocused document rejects `writeText` with `NotAllowedError: Document is not focused`. The direct call was reproduced failing on a real page while `execCommand` in that same page returned `true`, so a copy path that skips the shared contract reports "couldn't copy" for selections it could have copied. The toolbar passes `notifyFailure: false` and raises its own toast because the global hook in [`entry.tsx`](../../../../apps/web/src/entry.tsx) is configured before the locale tree mounts and can only emit static English strings; callers that can reach the reactive locale own their own failure copy. No second wrapper exists around `copyTextToClipboard`, matching how [`reader.tsx`](../../../../apps/web/src/components/execution/reader.tsx) already calls it inline.

## Alternatives considered

**Register Add to chat as a plugin text action.** It would have reused the registry with no new surface, but it would make a core Composer capability depend on a plugin being installed, and it would push `kind: "quote"` through the plugin API version boundary for a host-owned feature. Host behavior belongs in the host; plugin actions stay distinct, as the plugin documentation states.

**Keep the right-click menu and only add an action to it.** That preserves the old surface but keeps the discovery problem: a reader who never right-clicks never learns the action exists. The whole complaint was that selecting text produced no visible effect.

**Insert the quoted text inline into the editor as a `>` block instead of a reference chip.** It reads closer to Markdown, but it puts a long passage inside the text the user is editing, mixes authored words with captured words, and cannot be removed or reordered as one unit. The reference-chip form matches how sessions, notes and files already behave.

**Add a selection action to the plugin UI API contract.** Unnecessary: the host registers its own action against the same in-process registry, and the plugin-facing contract is untouched.

## Consequences

Selecting transcript text now answers with a toolbar, and Add to chat puts the passage in front of the model as a distinguished quote. The path is device-verified: the toolbar appears on a settled selection and the click inserts a quote chip into the Composer.

Editor selections intentionally get no toolbar, so the two paths differ: pointer and keyboard selection behave identically in reading surfaces, and text entry keeps native editing. Code selections route to the same toolbar even where no `data-message-role` exists, because `source: "code"` is enough to establish a reading surface.

The tab order and focus move into the toolbar while it is open; Escape closes it. On narrow screens it becomes a bottom sheet rather than a tooltip, because a 32rem row cannot fit beside a selection on a phone.

The retired plugin surface, its position helper and its interaction copy are deleted rather than left behind, and the plugin documentation now points at the host surface as the owner of loading, error, retry and narrow-screen presentation.
