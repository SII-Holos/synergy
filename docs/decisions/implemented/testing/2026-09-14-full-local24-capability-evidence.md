# Decision Record: Full local-24 capability evidence

Status: implemented

## Problem

A selected-task core-runtime experiment does not measure the product composition or complete local task inventory. A composition name alone also cannot establish which agents are visible or whether registered capabilities work in the task environment.

## Decision

The [full local-24 preset](../../../../benchmark/configs/glm53-full-local24.yaml) fixes five harnesses, all 24 tasks and one repeat, with Synergy's full composition and `synergy-max`. Offline inspection records registered tool IDs, agent identities, model roles and the primary's normal delegation list. Native availability remains a separate observation. The preset declares longer startup, probe and export budgets without changing verifier limits; the independently configurable probe execution deadline retains its 120-second default elsewhere.

## Alternatives considered

**Reuse the core experiment with a new label.** Its composition, primary agent and task selection are different experimental conditions; relabeling would misrepresent the measured system.

**Expose every agent by overriding visibility.** Hidden and host-selected agents are part of product orchestration, while the model has its own delegation catalog. Flattening visibility would measure a modified agent rather than the standard installation.

**Reuse the formal solving deadline for probes.** A simple connectivity/tool preflight needs an independent declared budget. Sharing the formal deadline makes a small preflight unexpectedly inherit hours of execution.

## Consequences

The full preset declares a 128 GiB logical cache budget for all task images and frozen harness bundles while retaining the independent free-disk floor. Cache accounting can count shared image layers more than once, so the budget is not a reservation or a prediction of physical disk consumption. Existing frozen runs retain their recorded resource settings.

The 120-cell preset is reproducible and distinguishes registered capability from operational availability. Default native prompts, visibility, permissions and task environments remain intact. Linux, network, credential and model-protocol restrictions must accompany any claim about full-product results. Pure tests exercise every harness's formal and probe launch deadlines and preserve native verifier settings.
