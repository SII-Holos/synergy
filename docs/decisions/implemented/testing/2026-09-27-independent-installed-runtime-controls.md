# Decision Record: Independently schedule installed runtime controls

Status: implemented

## Problem

Installed acceptance combines native watcher validation, core and full builds, both compiled distribution suites, a separate core tarball installation, component compositions and the installation upgrade lifecycle. One serial task assigns all nine commands the same job deadline. Hosted runs with identical runtime, fixture, build and workflow source trees completed those commands in one run and exhausted the job deadline while still completing checks in another. The shared job can expire before every independent control finishes; the cancellation does not establish a byte-transfer failure or a particular stalled runtime operation.

## Decision

The catalog exposes independent core and full artifact tasks. Core owns its watcher check, distribution build and behavior suite, workspace pack and clean tarball suite. Full owns its distribution build and behavior suite, component compositions and installation lifecycle. The existing nine commands execute once across the two recipes, with unchanged arguments, assertions and deadlines. Both retain the verified shared native prerequisites and isolated task environments.

Full builds its own workspace dependency closure, including CLI modules, before constructing its module archives and distribution. Its component and installation consumers use those archives in fresh directories outside the repository. It requires neither a core distribution nor an installed Home from the core control. Shared CI preparation continues to validate SDK, Plugin and native assets; it cannot substitute for either distribution build.

The existing bounded Linux matrix assigns the two controls to different workers and leaves full on its own worker in required full, shadow and affected plans. The core and full scheduling estimates are 18 and 30 minutes; these are placement weights, not new deadlines or asserted performance thresholds. Catalog tests exercise those required plans and diagnostics selecting only the two installation controls, preserve all nine command recipes and check their build prerequisites and input paths. Other diagnostic selections retain the general two-worker packing policy. Admission still requires every selected task from the current plan, SHA, run and attempt.

## Alternatives considered

Increasing the shared job deadline leaves unrelated installation controls coupled and supplies no evidence about a slow product operation. Reducing payloads, skipping package combinations or reusing successful results would weaken acceptance. Replacing distribution builds with the shared preparation artifact would omit their generated module archives and installed runtime seeds.

Packing core dependencies again costs a small part of this chain and independently exercises the workspace publishing entrypoint. Removing that check does not address the serial scheduling constraint. A new cross-job distribution cache would require another content inventory and ownership protocol; two self-contained recipes reuse the existing plan and report machinery.

## Consequences

Independent installation controls can complete and publish evidence without waiting for the other distribution. The nine acceptance commands and runner concurrency remain unchanged. Each control creates its own isolated task environment and shares runner setup with its assigned worker. The full task still contains its complete installation lifecycle, including native input length and SHA-256 checks in both core and full generations.

Placement estimates need maintenance as the catalog grows. A local recipe or topology test does not certify hosted performance or replace a complete green CI run. The specific host cause of the observed command-duration variation remains unproven, and cancellation continues to reject admission.
