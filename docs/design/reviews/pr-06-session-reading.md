# PR 06 — Session reading flow

## Intent

Make the conversation read as one continuous stream. Assistant content, activity traces, and tool results keep their existing semantics while reducing unnecessary vertical jumps between adjacent parts.

## Changes

- Reduce the default gap between timeline items from 12px to 10px.
- Reduce the assistant message internal gap from 12px to 10px.
- Preserve larger semantic separation before and after tools, attachments, and reasoning blocks.
- Keep copy, rewind, focus, and responsive behavior unchanged.

## Review visual

See `assets/pr-06-session-reading.svg` for the rhythm comparison.