# Decision Record: Retain early fixture completion signals

Status: implemented

## Problem

The Cortex progress test publishes observable child progress before assigning its continuation callback. If the observer requests completion during that interval, optional invocation discards the signal and the fixture remains running until its existing deadline.

## Decision

Allocate the continuation deferred before launching the fixture. Keep the existing progress and terminal-state assertions, and use a second barrier to exercise progress observation and release before the mock starts awaiting that continuation. Resolve both deferreds during cleanup.

The same controlled ordering fails with the former late callback and passes with the preallocated deferred. This establishes the fixture's synchronization property without adding a sleep, retry or longer deadline.

## Alternatives considered

**Rerun until green.** Another schedule can avoid the race without removing the lost signal.

**Increase the completion deadline.** A discarded signal cannot be recovered by waiting longer.

**Wait for a callback to appear.** Polling adds another scheduling assumption when a promise can retain an early resolution directly.

## Consequences

Cortex runtime behavior and test coverage remain unchanged. The existing case now also exercises early completion release deterministically. The [postmortem](../../../postmortem/0041-cortex-progress-fixture-lost-release.md) distinguishes the observed CI failure from the controlled reproduction.
