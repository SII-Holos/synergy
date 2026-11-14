# Decision Record: Wrap user prose at word boundaries

Status: implemented

## Problem

The shared user-message text container used `word-break: break-all`. Ordinary English words split between lines in both narrow and wide conversations, reducing readability. A long-history App fixture measured individual word ranges crossing rendered lines for words such as “older”, “evidence” and “messages”.

A long URL also expanded the organization's implicit transcript grid column beyond its reading viewport. Hidden overflow clipped ordinary prose and the URL while the widened message's own client width still matched its content width. Comparing only those internal widths gave a false positive until screenshot review and descendant ranges exposed it.

## Decision

The canonical user-message container uses normal word breaking with `overflow-wrap: anywhere`. Ordinary prose keeps its word boundaries while long URLs and unbroken identifiers can wrap inside the available message width. Chinese and English content shares the same rule. Whitespace, Markdown/source selection, long-message expansion, fonts and theme tokens retain their existing owners.

The organization transcript row owns one `minmax(0, 1fr)` grid column. Its available width constrains both ordinary user and assistant message renderers rather than allowing a long token's intrinsic width to expand the track. Code and table readers keep their local horizontal scrolling.

## Alternatives considered

**Override only organization messages.** The defect belongs to the shared user-message selector. An organization-only override would leave the same prose unreadable in other consumers.

**Disable internal word wrapping.** Long URLs and identifiers must remain readable inside narrow messages without being clipped or creating page overflow.

**Check only page width.** Hidden overflow can mask clipped text, and a page can fit while every English word splits incorrectly. The App fixture inspects word ranges and the message's own content width with mixed text and a long URL.

## Consequences

User prose remains readable through the shared renderer without an organization-specific style. The real conversation fixture pages through 320 messages at 375 and 1100 pixels, measures the oldest hydrated row against its reading viewport after a user scroll, and verifies ordinary word ranges, mixed-language content and long-token containment. It also checks lazy body reads, bounded mounted rows and returning to the latest page. These geometric checks do not establish settled painting for every narrow virtualized history state, model performance or untested browser behavior.

The later [Latest navigation regression](2026-11-12-navigate-to-the-latest-shared-message.md) complements those ranges with first-image pixel checks after mounted-body geometry settles. The initial blank narrow image remains failed diagnostic evidence; later readable captures do not establish a native overscroll or general compositor fix.
