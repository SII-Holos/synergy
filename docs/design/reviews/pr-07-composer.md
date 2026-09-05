# PR 07 — Composer hierarchy

## Intent

Make the composer feel attached to the conversation instead of floating as a separate card. The editor remains the primary surface; toolbar controls recede until needed.

## Changes

- Replace the oversized composer shadow with a restrained elevation cue.
- Use the existing radius token for the shell.
- Reduce toolbar padding to give the editor more visual weight.
- Soften selector chips without changing their interaction states.
- Preserve focus, drag-over, narrow-container, plugin slots, and submit behavior.

## Review visual

See `assets/pr-07-composer.svg` for the hierarchy comparison.