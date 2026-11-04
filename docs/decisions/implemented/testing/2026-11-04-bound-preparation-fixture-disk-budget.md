# Decision Record: Control disk admission in preparation failure fixtures

Status: implemented

## Problem

The preparation failure fixture used the default twenty-GiB free-disk reserve while injecting a source preparation exception. On a runner below that reserve, real cache admission rejected the empty fixture before the injected failure. The test therefore depended on unrelated host storage and never reached the durable preparation failure contract it was meant to verify.

## Decision

Declare a positive half-GiB disk reserve and one-GiB cache budget in this fixture, and control the disk sample at one GiB free. Keep real temporary cache admission and durable run files. Assert that the exact injected exception propagates for both ordinary failure and interruption, that the recorded stage remains source preparation, and that no resumable plan appears.

Keep evaluator defaults and cache rejection behavior unchanged. Existing cache tests continue to verify rejection below the declared reserve and preservation of frozen inputs and unowned files. Release recovery recognizes this private workspace's test directory as fixture-only input while still rejecting evaluator source and runtime changes.

## Alternatives considered

**Rerun until the host has more free disk.** This leaves the failure scenario dependent on unrelated runner storage.

**Mock cache admission or disable its budgets.** That would bypass the real boundary instead of giving the small fixture explicit resource requirements.

**Lower the evaluator's default reserve.** A fixture does not justify changing resource policy for research runs.

## Consequences

The controlled low-disk sample reproduces the old failure deterministically and reaches the intended source failure with the explicit fixture budgets. Verification covers preparation, cache and configuration tests, plus release recovery's accepted and rejected paths. Product runtime and benchmark execution behavior are unchanged.
