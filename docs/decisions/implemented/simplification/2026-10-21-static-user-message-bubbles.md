# Decision Record: Keep user-message reading surfaces static

Status: implemented

## Problem

Hovering a user-message text bubble changes its background, strengthens its border and adds a focus overlay, even though the bubble has no whole-message click action. Collapsed-message fades and expansion buttons also follow the parent's hover state. This makes ordinary reading content look interactive and duplicates feedback belonging to its actual controls.

## Decision

Remove the shared text-bubble hover and descendant-focus surface rules, their color transitions, and dependent parent-hover styling for collapsed fades and expansion controls. Remove redundant metadata hover selectors that only repeat its always-visible, pointer-enabled state. Keep the resting theme surface and shared background value used by the bubble, fade and expansion button.

Copy, source switching, message expansion, attachments and rewind retain their existing controls and local interaction behavior. No pointer state, event handler or replacement hover override is added.

## Alternatives considered

**Reduce the hover contrast.** A weaker whole-bubble response still advertises an action that does not exist.

**Override hover colors at the App layer.** This leaves the redundant shared rules and their dependent highlights active in other consumers.

**Remove all message-related hover behavior.** This also removes useful feedback from actual buttons and attachment links, outside the requested change.

## Consequences

User messages remain readable and selectable without whole-bubble highlighting. Long messages keep their static fade and keyboard-operable disclosure. Browser regressions exercise short and collapsed messages at narrow and desktop widths in both themes, comparing actual computed surfaces after transitions settle and retaining source switching, text selection and local button feedback.
