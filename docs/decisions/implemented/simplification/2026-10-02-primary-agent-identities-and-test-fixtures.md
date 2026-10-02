# Decision Record: Centralize primary identities and separate synthetic test agents

Status: implemented

## Problem

Primary names appear in registration, default configuration, delegation, workflow branches and tests. A naming change can miss a behavior branch or require edits to unrelated message and presentation fixtures. Primary prompt builders also accept an unused agent catalog and share memory instructions through one named primary.

## Decision

Harness exposes primary identities indexed by the stable responsibilities general, coding and lightweight. Runtime consumers use that catalog; prompt directories and builders use responsibilities and render identity placeholders. Shared memory instructions have their own module. Testing supplies synthetic names without importing Harness. Built-in behavior tests select a responsibility; one identity contract verifies concrete names independently.

## Alternatives considered

**Replace name literals across the repository for every rename.** This repeats maintenance and can change product identifiers or historical evidence.

**Make every test derive its expected identity from the production catalog.** That cannot detect an incorrectly configured catalog. The identity contract and historical upgrade fixtures retain independent expectations.

**Use synthetic agents for every test.** Delegation, model-role and tool-exposure regressions need the actual built-ins. Synthetic fixtures are limited to behavior independent of a built-in identity.

## Consequences

Runtime registration and workflow behavior retain one source of primary names. Generic fixtures survive naming changes. Prompt builders stop consuming an unused catalog; routing completeness remains verified through the initialized task description. Unique permission, lifecycle and budget checks remain covered.
