# Decision Record: Put execution-record controls on the title row and name message records by kind

Status: implemented

## Problem

Two separate surfaces in Execution records carried a cost the panel did not earn.

The search field, filter menu, process/records switch, ordering switch and exceptions toggle were stacked inside the trajectory column. That column is capped at 320px so the inspector can take the remaining width, so the controls wrapped into four bands and consumed 145px of vertical space even on a 1440px display. The column never had room for them: the wrapping was a property of the container, not of the viewport.

Selecting a message-sourced record produced a heading made of that record's own text, because the trajectory projection stores a message part's text in the node title. The heading therefore grew to a paragraph, while the body showed only the pointer record `{sessionID, messageID, partID}`. The text took the place reserved for identity and the content it belonged to was absent.

## Decision

The record controls live on the records title row. `.execution-filters` is a wrapping flex row inside `.execution-records-header`, holding search, the filter menu and both switches; the export action follows it. Exceptions and retries belong inside the filter menu and count toward its active-filter badge. The redundant all-task scope label is omitted. It stays on one line down to the width where the controls genuinely stop fitting and only then wraps. The orphaned `.execution-global` wrapper and the `.execution-search-row` / `.execution-view-row` rules leave the stylesheet, and the ordering switch drops the `.execution-record-controls` class that only existed to pair with the removed view row. Below `48rem` container width, inspecting a record hides the toolbar along with the trajectory column, because the toolbar only controls that list.

A message-sourced record is identified by its recorded kind and reads its saved text as evidence. `heading()` returns the kind label for nodes whose source is `messages` and the metadata line omits the kind when the heading already is it. The inspector body renders the shared bounded reader for these nodes instead of a serialized pointer. `ExecutionService.contentSource` returns a part's text directly as `text/plain` when the part carries one, and keeps the serialized `{info, part}` JSON for parts without text. Empty text remains a complete zero-byte body rather than a missing record.

## Alternatives considered

**Shrink the controls until they fit the 320px column.** Four text labels and a search field cannot fit 320px without hiding meaning; truncating the switches or moving labels into tooltips trades a layout problem for an unclear one, and the column would still be spending its height on controls for a different region.

**Keep the controls in the column and accept wrapping below `48rem`.** Measured behavior already wrapped at every width including 1440px, so this preserves the defect rather than bounding it.

**Give the message record a short title derived from its text.** Any truncation invents a name the record does not have and hides the distinction between the record's identity and its content; the kind is already accurate and the full text is available in the body.

**Render the saved text from the detail record directly.** The pointer record does not contain the text, so this would require widening the detail payload for every consumer instead of reusing the versioned content channel the other evidence already uses.

## Consequences

The records header uses one 36px row instead of a stacked control block, so the trajectory list gains about 110px of height at desktop widths; narrow containers wrap instead of overflowing. Because the toolbar now sits outside the trajectory column, the narrow inspecting state hides it explicitly, so record reading is not framed by controls for a list that is off screen.

Message records lose their text-as-heading, so a reader now sees `Reply`, `User input` or `Reasoning` plus status, and reads the content in the same bounded reader as every other saved body — with its own search, download and copy actions. The content channel reports `text/plain` for parts with text, so a client that previously parsed a message body as JSON must rely on `mediaType`; the workbench route test asserts both the media type and the exact text.
