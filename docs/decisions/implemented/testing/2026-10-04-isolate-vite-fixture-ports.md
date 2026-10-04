# Decision Record: Allocate independent Vite fixture ports

Status: implemented

## Problem

Browser fixtures can overlap across package test processes. Passing zero to Vite does not request an operating-system-assigned listener in the installed version, and fixed ports also collide with other fixtures. A CI run failed before Markdown assertions because the shared default port was already occupied.

## Decision

The remaining Web and shared UI Vite fixtures use the existing `fixturePort()` helper to allocate a nonzero loopback port. Each fixture uses its own server's resolved address and closes its server during cleanup. Existing strict-port settings and behavioral assertions remain intact.

Verification reserves the default and former fixed ports while running the actual Markdown, Tooltip and ProviderIcon suites. Their original configuration fails, and their corrected configuration completes the same assertions. The affected Web suites also run with those ports occupied.

## Alternatives considered

**Rerun the failed CI job.** Different overlap can hide the conflict without removing shared port ownership.

**Assign another fixed port per suite.** This only relocates collisions and requires coordination across package processes and local worktrees.

**Disable strict-port checks everywhere.** Automatic fallback can mask unintended shared configuration; the existing explicit allocation helper already supplies independent ports.

## Consequences

Port allocation still has the helper's short release-before-bind interval. A strict listener reports a rare intervening bind instead of consuming another fixture's service. Ordinary application ports and behavior do not change. The [postmortem](../../../postmortem/0040-vite-fixtures-shared-default-ports.md) records the reproduction and dependency behavior.
