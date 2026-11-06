# Decision Record: Focused MCP configuration in Settings

Status: implemented

## Problem

Expanded server cards mixed required connection fields, optional credentials and advanced policy into the resource list. The forms lacked consistent insets and made multiple servers difficult to scan. Patch normalization could discard an unnamed draft or overwrite another server with the same name before the user received a field error.

## Decision

Use a searchable server list and a focused configuration subview within the existing Settings shell. Keep server intent, draft completeness and runtime health distinct. Show name and transport first, followed by command or HTTP URL. Edit environment variables and request headers as stable key/value rows; keep timeout and model tool visibility in an advanced disclosure. Expand built-in credentials only when requested.

Retain drafts in the Settings owner and keep the shared footer as the only preference write action. Remember the list search, scroll position and entry used to open configuration. Escape returns from configuration after the menu layer closes; restore focus after the existing Settings transition. Validate required fields, unique names, remote URL protocols, integer timeout and pair names before normalization. Validation opens its server independently of the active filter or subview.

Keep the persisted MCP schema and runtime connection interfaces unchanged. Use Worktree / 工作树 consistently for the existing Git setting. The interaction and verification rules live in the [Web product contract](../../../../apps/web/PRODUCT.md) and [frontend development skill](../../../../.synergy/skill/develop-frontend/SKILL.md).

## Alternatives considered

**Expanded forms in every server card.** These keep editing adjacent to the summary but make the list dense and duplicate all technical fields across resources.

**A separate per-server Save dialog.** This narrows visual focus but introduces another preference commit boundary alongside the existing cross-page drafts and footer.

**Free-form environment and header text.** This is compact for experienced users but obscures names, values and duplicate entries. Key/value rows keep their existing record representation while making each entry directly editable.

## Consequences

Configuration is one view transition away from the list. Required fields stay visible while advanced policy requires a disclosure. Creation and editing do not start servers or publish drafts. Rendered regression tests cover list recovery, transport drafts, compound values, row focus and narrow content; validation and existing credential/status tests preserve the save and runtime distinctions.

Deferred focus for a newly added pair applies only while focus remains on its initiating control. Editing another field before the next frame cancels that focus transfer, preserving continuous input on slow or busy frames.
