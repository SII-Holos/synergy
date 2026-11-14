# Decision Record: Prepare sandbox assets for independently selected distributions

Status: implemented

## Problem

Affected frontend verification could select the Web integration task and its full distribution without selecting an installed-artifact or sandbox task. Preparation derived sandbox bundling only from those task kinds, leaving the required Linux native sandbox helper absent when the full distribution was packed.

## Decision

CI preparation includes sandbox assets when any selected task consumes a core/full distribution, requests the sandbox prerequisite or belongs to the existing sandbox/artifacts kinds. Unselected consumers cannot widen preparation. The existing verified build inventory and sandbox-sensitive cache identity carry the helper to distribution producers.

Organization Runtime suites declare the sandbox prerequisite because their actual accepted commands execute native tools through the standard autonomous profile. Their selected execution units prepare the verified helper independently of browser prerequisites; a missing helper remains a runtime failure rather than a reason to bypass sandboxing.

## Alternatives considered

**Making the helper optional in CI archives.** This would stop testing the required native package closure and weaken the installed distribution contract.

**Selecting every installed-artifact task for frontend changes.** This adds unrelated tests while expressing a build input through a test-selection side effect.

## Consequences

Standalone Web distribution verification prepares the same required native inputs as installation verification. Ordinary Web suites still avoid unnecessary sandbox preparation. A catalog-based regression checks independently selected Web integration, core installation and ordinary Web suite plans.

The same catalog regression checks every Organization Runtime suite and its selected unit. Planner, revision-input and dependency tests preserve unrelated selection and preparation behavior.
