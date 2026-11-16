# Decision Record: Isolated welcome browser scenarios

Status: implemented

## Problem

Welcome browser scenarios share a mutable page across cases. Randomized order exposes inherited media preferences, pointer position and viewport state, changing motion and input assertions. A single case also places all twenty-four layout combinations under one deadline, so a slow run can interrupt later cases that still depend on the same page.

## Decision

Keep the immutable fixture server and browser process shared, but create and close a fresh browser page and its context for each case. Default viewport, media, input and storage state then belong to that case. The layout matrix retains every scene, width and height combination and gives each scene its own case with the existing deadline.

## Alternatives considered

**Reset a list of page settings between cases.** A partial reset cannot reliably cover input capture, focus, storage and future browser state.

**Increase the shared deadline or retry failures.** Neither repairs the inherited state, and both can hide a reproducible ordering defect.

## Consequences

The suite retains rendered motion, keyboard, touch, theme and layout assertions. Each case adds page creation and disposal while reusing the server's compiled modules. Deterministic order seeds and the complete Web inventory verify isolation and preserve coverage requirements.
