# Decision Record: Oryn repository-local maintenance

Status: implemented

## Problem

The repository needs model-assisted triage, readable reviews and validated repairs that work with its Bun workspace graph and existing release gates. A resident automation service or persistent model knowledge store would duplicate repository-owned decisions and create another deployment to maintain. Legacy Oryn labels also describe stages without an active Actions receipt.

## Decision

Use the Oryn Mini runtime pinned by [setup-oryn](../../../../.github/actions/setup-oryn/action.yml), adapting the repository-local Actions integration from YourTJ-Hub. The authoritative setup action records its commit-pinned provenance and local adaptation. Native events execute trusted default-branch workflow code; the model sees candidate source separately. App installation tokens separate runtime reads from publication, while GLM inference uses its own repository secret.

Enable the capability catalog through [operator policy](../../../../.github/oryn/repositories.json), including triage, commands, images, labels, repair/adoption/rebase, clusters and gated close/merge. Keep `All checks passed` and independent maintainer approval as merge prerequisites. Release promotion remains in the repository release workflow. Model memory is ephemeral; GitHub receipts contain bounded operational state and durable reasoning belongs in decision records and tests.

A trusted validation entry captures the workspace graph from the workflow revision, selects changed owners and transitive dependents, and runs package typecheck/test commands inside the credential-free sandbox. Root or unknown executable changes select every workspace. Documentation-only changes run governance checks. Evidence snapshots remain outside both candidate source and the writable validation home. Native platform, coverage and installed-artifact validation remain in CI.

Maintain canonical advisory labels alongside human-owned labels. Migrate matching legacy classifications without dropping assignments; retire stale in-progress stages to needs-triage on open items rather than claiming current execution. The [operations guide](../../../operations/oryn.md) owns setup, verification and command details.

## Alternatives considered

**Run the sweeper from another repository.** Centralized execution reuses configuration but separates target secrets, Actions history and operational ownership from this repository.

**Copy the complete Synergy product or persist model experience.** This adds deployment and storage responsibilities unrelated to repository maintenance and duplicates decisions already owned by version control.

**Use one unconditional full test matrix for every repair.** This consumes the bounded task budget on unrelated work. Selecting trusted workspace owners and dependents provides focused evidence while the existing CI matrix retains platform and coverage checks.

## Consequences

Maintainers get repository-local runs, evidence-backed human reports and tested draft repairs without a resident service. The integration must track the pinned Oryn catalog and the trusted workspace graph, and large dependency changes can exhaust the validation budget. Capability opt-in does not bypass source freshness, command authority, validation or merge approval. Static workflow exceptions are narrowly scoped to verified constructs rather than disabling general audits.
