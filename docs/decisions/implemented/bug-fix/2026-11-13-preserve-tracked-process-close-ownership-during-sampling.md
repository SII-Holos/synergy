# Decision Record: Preserve tracked process close ownership during sampling

Status: implemented

## Problem

A native child can exit before its tracked output and recording completion finishes. Resource sampling treated the dead PID as stale during that interval and published a failed result without the original exit code. A concurrent poll could observe that result even when the genuine close owner later saved successful completion.

## Decision

The Process Registry's stale sampler leaves a process with an existing tracked close completion under that original owner. Sampling remains nonblocking and reports physical observations without publishing terminal status. The original close path still determines output drainage, recording completion, exit code and final status. Processes without a tracked close owner retain the existing missing-child recovery behavior.

## Alternatives considered

**Wait for close completion inside every sample.** Listing and resource inspection must remain bounded observations; a delayed recorder must not turn each sample into a blocking process wait.

**Correct a failed poll from later metadata.** This preserves the race and permits inconsistent terminal results. The sampler must not take completion away from the existing owner.

## Consequences

The fix preserves the native close lifetime without changing process authority or inventing an exit code. A real child test holds the tracked close tail after physical exit, verifies sampling leaves it unfinished, then releases the original owner and observes successful completion. The Registry suite retains missing-child and sampling-generation coverage. See [the incident](../../../postmortem/0182-process-sampling-raced-original-close-completion.md).
