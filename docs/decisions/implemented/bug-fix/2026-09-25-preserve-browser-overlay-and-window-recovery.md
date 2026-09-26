# Decision Record: Preserve Browser overlay and window recovery

Status: implemented

## Problem

Browser prompts lacked text input, Electron’s default prompt throws before emitting a dialog event, dialog replies could queue behind the command awaiting them, bespoke controls menus did not own keyboard dismissal, and native content could obscure DOM controls. Restored windows only needed one pixel of display overlap. Workbench dimensions did not react to changed available space.

## Decision

Use shared dialog and popover boundaries for Browser decisions and controls. Preserve prompt defaults, explicit empty replies and cancel semantics. Include controls, errors and annotations in native visibility without detaching the canonical page. Bound Desktop restoration to a current work area, preferring the largest overlap, and retain maximization. Observe the session container for workbench limits while preserving the user's preferred dimensions.

## Alternatives considered

**Recreating native content or using a screenshot overlay** would risk page state and violate the native presentation contract.

**Persisting every constrained panel dimension** would erase the user's layout whenever the window shrinks. Presentation limits remain separate from preferences.

**Discarding all offscreen bounds** would lose valid window dimensions and maximized state. Fitting the saved state preserves those choices where the current display permits them.

## Consequences

The explicit remote client mode starts viewer signaling after first page creation even if the initial capability snapshot was empty; native clients remain strict. Native content is temporarily hidden while an overlapping control requires interaction. DOM component tests cover prompt semantics, focus, combined blockers and resize recovery. Real Electron checks retain page identity and input state across visibility changes and validate restoration against the actual work area. Simulated display topologies cover disconnected and negative-coordinate monitors.

The Browser-only preload replaces Electron’s unsupported prompt through the public context bridge while keeping sandboxing and context isolation enabled. The host accepts only bounded prompt strings from its own main frame and returns text or null through page-scoped IPC; disposal cancels pending prompts. Both native and remote real Electron tests execute the actual prompt and validate all three return cases. Host packaging includes and checks the single preload. The existing protocol is unchanged. The separate dialog response lane preserves replay and owner validation, re-enters only the live command’s binding context, and drains before releasing that lease.

Implementation references: [Electron 42.5.0 window setup](https://github.com/electron/electron/blob/v42.5.0/lib/renderer/window-setup.ts) establishes the unsupported prompt behavior; the [public contextBridge contract](https://www.electronjs.org/docs/latest/api/context-bridge) defines isolated synchronous function proxies.
