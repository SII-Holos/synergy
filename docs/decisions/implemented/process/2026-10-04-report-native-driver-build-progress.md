# Decision Record: Report native driver build progress

Status: implemented

## Problem

Desktop's native Computer driver preparation can spend several minutes downloading source and compiling two architectures. Silent network work and implicit cache decisions leave developers unable to identify the current operation or distinguish waiting from an exited build. The development orchestrator forwards child output by complete lines, so cursor-based progress updates would need additional terminal handling.

## Decision

The driver preparation script owns newline-terminated stderr status with a Computer prefix. It reports each phase before beginning work, immediately reports completion or failure, and adds a pending-status line every five seconds using a monotonic clock. Each phase releases its timer on settlement, and status timers do not keep the process alive. Native command output remains inherited and failure keeps its original error and exit behavior.

Download status uses received bytes and transfer rate over the latest reporting interval. Only a positive, safe response length without content encoding can supply a total; an unknown or inconsistent total never produces a percentage. Phase waiting time is not proof of advancing work and does not extend the existing download deadline. Driver cache rejection reports its reason, validated caches report reuse, and final readiness follows executable and receipt publication.

The existing source pin, archive and executable digests, size limit, Rust version, universal architecture requirement and receipt format remain authoritative. The [development reference](../../../reference/development.md#requirements-and-preparation) owns the status behavior; the [Computer development workflow](../../../../.synergy/skill/change-computer-runtime/SKILL.md) owns verification.

## Alternatives considered

- A terminal spinner or cursor-updating progress bar would require the development orchestrator to forward partial lines and arbitrate compiler output.
- A percentage for the complete build would estimate incomparable network and compilation stages without a reliable total.
- A shared build-progress framework would expand ownership beyond the native-driver preparation that needs feedback.

## Consequences

Direct builds, development startup and CI receive the same readable status without a new transport or dependency. Long builds add up to twelve waiting lines per minute per active phase. The feedback explains work and cache reuse but does not shorten the source download or compilation, and cancellation continues to belong to the existing process owner.
