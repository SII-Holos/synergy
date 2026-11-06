# Decision Record: Browser failure presentation

Status: implemented

## Problem

Browser load failures exposed a generic issue heading, recovery prose, a diagnostic disclosure and distant actions above an empty page. Suspended pages already had one clear state and recovery action. Treating every browser error as a whole-page failure would also conceal working pages after an operation timeout or popup failure.

## Decision

Apply the [single-gesture recovery layout](2026-10-22-single-gesture-browser-recovery-state.md) to an active page whose canonical main-frame navigation has failed with a structured error. The state contains the destination site mark, a load-failure title and one Reload page action. Specific failure guidance remains visible when it changes the next action; generic request explanations stay out of the state.

Only presentation detaches. The native page, profile and page ID survive, and explicit reload navigates the recorded requested address. Loading disables repeated recovery clicks. New canonical navigation restores presentation. Operation failures and uncertain timeouts retain the usable page and a compact dismissible notice. Suspended and recovering pages do not duplicate that notice.

Error details are reached from the existing page menu and use the shared dialog and copy controller. Their content is captured for the initiating page and redacted by the existing error presenter; closing the dialog returns focus to its connected menu trigger. The shared view-activity boundary dismisses it when its page becomes inactive. Short recovery surfaces scroll within their panel instead of clipping the only action.

## Alternatives considered

**Shorten the existing error banner.** This reduces copy but leaves a failed full-page load with a notification layout and repeats suspended or recovering states.

**Replace the page whenever an error exists.** Popup errors and uncertain commands can coexist with usable content and unsaved forms. They cannot justify detaching the page.

**Remove technical details.** This simplifies the default view but discards evidence needed for diagnosis. The existing menu offers a secondary location without a permanent disclosure or another primary action.

## Consequences

Load failure and suspension share visual hierarchy while retaining their different recovery operations. Diagnostics require opening the page menu, and optional cause-specific guidance can make the state taller. Browser fixtures exercise state selection, native attach/detach requests, retry identity, copy, focus, theme and narrow geometry; native composition remains a separate Desktop acceptance boundary.
