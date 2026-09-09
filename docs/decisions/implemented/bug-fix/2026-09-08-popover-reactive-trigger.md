# Decision Record: Distinguish Popover JSX from trigger components

Status: implemented

## Problem

Solid reactive JSX can be a function. Popover interprets a function-valued Tooltip result as a component, so trigger handlers and refs never reach the DOM and the session action button does not open its menu.

## Decision

Popover accepts rendered content through `trigger` and an explicit native-button component through `triggerAs`. It does not inspect JSX with `typeof`. The session action menu uses `triggerAs` to forward Kobalte events, ref, and accessibility attributes to its actual button inside the Tooltip. The existing JSX wrapper path remains available to other callers. The plugin component binding maps its existing component-valued `trigger` to `triggerAs`, preserving the public plugin API.

## Alternatives considered

**Add a click handler only to the session button.** This leaves other reactive JSX callers broken and does not restore the primitive's focus and keyboard behavior.

**Infer a component from a function's arity.** Solid compilation and accessors make that another unreliable runtime heuristic.

## Consequences

Session actions open with pointer and keyboard input and return focus after Escape. Component callers use the explicit prop; rendered JSX callers keep the existing prop. A real browser fixture covers reactive Tooltip content, repeated actions, native keyboard activation, and focus restoration. Each case loads a fresh document so deferred focus cleanup cannot cross case boundaries; keyboard dismissal waits for the content autofocus to complete before sending Escape.
