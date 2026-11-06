# Decision Record: Keep user attachment state readable and recoverable

Status: implemented

## Problem

Large attachment tiles displace task input, column layouts change visible reading order, and a failed upload previously removed its card. Users could not retry that file or identify the attachment blocking submission.

## Decision

Draft and sent user attachments use compact cards and a row layout in addition order. Draft image thumbnails contain the image within 64 pixels and sent images within 88 pixels. Document cards retain the extension, type, size, full-name tooltip and accessible action. The layout folds after two measured rows, exposes the complete count and keeps hidden entries inert. Existing Agent attachment presentation remains the default.

Upload failures retain the same card identity, diagnostic and original File in composer-local memory. Retry replaces that entry rather than reserving another count or byte allowance. Uploading and failed attachments block ordinary submission, with a visible summary and retry/removal entrance. Removal, navigation and disposal invalidate late upload results and release temporary File bindings. No failed placeholder or browser File is persisted.

Remove controls remain visible for touch and keyboard focus. Removal returns focus to an adjacent attachment when retained, or to the add control. Shared attachment cards offer optional compact presentation and an opening callback without changing the Plugin public API.

## Alternatives considered

**Discard failed cards and ask users to select files again.** This obscures failure identity and prevents a direct recovery action.

**Persist browser File objects or errors.** Browser files cannot provide a durable recovery contract and may retain large memory-backed content.

## Consequences

Attachment recovery is explicit within the current draft. Reloading or switching sessions clears incomplete local uploads. Attachment upload policy, original bytes and model preparation remain unchanged.
