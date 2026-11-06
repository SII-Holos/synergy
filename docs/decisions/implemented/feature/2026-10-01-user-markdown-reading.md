# Decision Record: Render user Markdown from the original message source

Status: implemented

## Problem

Long user instructions lose headings, lists, tables and code structure when displayed as plain text. Rendering each file-reference segment independently would also break Markdown structure and reference positions.

## Decision

User messages have a non-streaming Markdown reader and a source view. Both copy and submission retain the original text; message schemas and model preparation remain unchanged. The reader parses one document with UTF-16 source positions, renders authoritative file references in ordinary text, and leaves references in code or link syntax available through source view. It never infers workspace files from displayed paths.

The reader uses [mdast](https://github.com/syntax-tree/mdast-util-from-markdown) and the [unist source-position contract](https://github.com/syntax-tree/unist#position), including GFM and math extensions. Code and math reuse the existing marked renderer, and generated HTML uses the existing sanitizer and reading enhancements. User HTML appears literally. Markdown images are explicit resource-opening controls rather than automatic network requests.

## Alternatives considered

**Render reference segments separately.** This loses block and inline structure spanning a reference, including emphasis and table cells.

**Persist rendered HTML or a rich-text document.** This introduces another content authority and changes copy, retry and model-input semantics.

The parser loads when the user reading surface is actually mounted. Importing shared message or composer components does not eagerly evaluate its parser dependencies. Loading or optional rendering failures retain readable source.

Inline formulas and fenced code use the same cancellable Markdown Worker as conversation rendering, with an explicit inline mode that does not introduce paragraph wrappers. Replacing a preview or unmounting it aborts its outstanding worker jobs.

## Consequences

Historical user text gains formatted reading without a migration. Original source remains accessible and copyable. Markdown parsing dependencies belong to shared UI; attachment policy and Agent streaming rendering remain unchanged.
