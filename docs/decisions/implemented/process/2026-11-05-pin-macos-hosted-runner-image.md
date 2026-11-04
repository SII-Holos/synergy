# Decision Record: Pin the macOS hosted runner image

Status: implemented

## Problem

Required macOS jobs cannot provide release evidence when GitHub repeatedly fails to allocate their hosted image. Retrying the same unavailable image does not exercise native Workspace behavior or signing, and neither local checks nor successful Linux and Windows jobs establish those macOS results.

## Decision

CI macOS jobs, their diagnostic matrix and Desktop release packaging use the standard `macos-26` ARM64 image. GitHub documents its architecture in the [hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). The selected tasks, serialized macOS execution, native signing scenarios, coverage requirements, portable-archive upgrade acceptance and final release promotion gates remain required.

The CI workflow and its command entry point are eligible corrections when resuming an existing candidate because they are not inputs to published modules or the reused native artifacts. Native helper workflows, product sources, dependency manifests and compilation scripts remain ineligible. Desktop's minimum supported system version remains owned by its application packaging configuration, independently of the hosted build image.

## Alternatives considered

**Keep retrying the same image.** This is the first response to a transient allocation failure, but repeated pre-execution cancellations justify validating another supported image.

**Switch to Intel or omit macOS checks.** Neither preserves the Apple Silicon execution evidence used by the macOS signing and upgrade gates.

## Consequences

The replacement image must complete the full CI selection and the release's actual macOS packaging and upgrade checks. It does not prove that capacity is always available or that older supported macOS versions have been exercised. Source and native artifact identity checks continue to protect an interrupted publication from mixing product revisions.
