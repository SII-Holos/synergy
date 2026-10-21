# Decision Record: Align attachment filenames and metadata in compact file rows

Status: implemented

## Problem

Compact filenames use a flex row while their metadata can inherit centered button text. With production fonts loaded, their first glyphs can differ horizontally by more than 31 pixels. Generic document cards also reserve unnecessary height and an icon tile. Long filenames can reserve an outer flex entry wider than the visible card, and stacked columns can exceed a phone pane.

## Decision

Ordinary files use a 56-pixel minimum row with a bare file-type icon. Filename and metadata share explicit start alignment, using the existing 14/20 title and 12/16 caption roles. Compact rows fit their content within a bounded maximum width; their outer entries receive the same constraint. Basenames truncate before a visible extension. Stacked columns fill, but never exceed, the available width.

File row density does not vary with media presentation size. Image dimensions, native media controls, resource identities and opening policy remain independent. Upload rows put state before size, keep retry text visible and reserve a separate removal target. Failure descriptions remain available through the retry Tooltip and accessible group description rather than expanding the file row.

## Alternatives considered

**Change only metadata alignment.** It fixes the immediate text offset but leaves the oversized file treatment and long-name overflow.

**Cap only the visible card.** Its uncapped flex entry can still reserve the untruncated filename width, producing extra rows and uneven alignment.

**Use a fixed width for every attachment.** It wastes space for short names and confuses ordinary file identity with image and media previews.

## Consequences

The shared file treatment covers tool evidence, user messages, delivered files and composer uploads without introducing a second file component. Browser verification mounts production fonts, theme and language providers, compares actual glyph edges, checks caption contrast in both themes, and covers long names, phone overflow, image geometry, keyboard resource dispatch, failure recovery and distinct touch targets. The component example page is for visual review, not a substitute for a complete workbench screenshot.
