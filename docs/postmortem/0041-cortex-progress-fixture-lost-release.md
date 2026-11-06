# Cortex progress fixture lost an early release

## Executive summary

A Cortex test observed the expected child progress but still found the task running after requesting completion. Its mock registered a release callback after publishing progress, allowing the observer to discard an early release. A preallocated deferred retains the signal regardless of when the mock begins waiting.

## Summary

Full CI failed the progress test's terminal-state assertion while its progress assertions passed. The test and runtime completion implementation were unchanged by the CI optimization. Ordinary local execution passed, so the investigation controlled the ordering between observable progress and the mock's continuation registration.

## Timeline

- On 2026-10-04, full CI reported a running task after the existing five-second completion wait.
- A barrier held the mock after progress publication while the test requested completion. The previous callback pattern reproduced the same failure locally.
- Allocating the deferred before launch made the controlled case pass with its existing assertions and deadline.

## Root cause

The fixture assumed progress observation happened after its release callback was assigned. Progress publication and completion of the publishing call are distinct events, so that ordering is not guaranteed. An optional call silently drops an early signal. The CI artifact did not record callback registration timing; the controlled reproduction proves that the fixture permits a lost release and reproduces the observed failure, without attributing a runtime defect from the timeout alone.

## Guardrails added

- The existing [Cortex progress test](../../packages/workbench/test/cortex/manager.test.ts) preallocates its release deferred and explicitly exercises release-before-wait ordering.
- Cleanup releases both the observation barrier and continuation.
- The [testing guide](../../.synergy/skill/testing-guide/SKILL.md) records early-signal handling, and the [decision](../decisions/implemented/testing/2026-10-04-retain-early-fixture-completion-signals.md) explains why retries or longer waits do not repair a lost signal.

## Lessons

Create test controls before starting observable work. An event can be delivered before the producer's awaited operation returns; synchronization must retain signals across that ordering.
