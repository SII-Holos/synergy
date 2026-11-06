# Decision Record: Gate release promotion on the final Desktop upgrade

Status: implemented

## Problem

Source and pre-sign upgrade tests do not establish that the signed portable application retains old data and can execute work. A release can otherwise publish an archive whose runtime changed during signing or whose installed layout differs from the tested candidate. A manual runbook step does not prevent automatic promotion when that check is omitted.

## Decision

The macOS arm64 packaging job extracts its final ZIP using the application's existing safe archive reader. It verifies the configured Apple signing identity and notarization, runs the pinned released-upgrade scenario against the extracted runtime, and verifies the signature again. It emits a receipt only after successful acceptance, with the release version, previous version, target, archive name and digest. Candidate Desktop package publication and stable finalization require that receipt and compare it with the archive bytes they publish or download. Existing platform package and signature checks remain required.

The runner is pinned to macOS 15 arm64 rather than a moving operating-system alias. Provenance: [GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Local adaptation: the acceptance executable rejects a different host architecture because its pinned previous release is arm64.

## Alternatives considered

**Test only the compiled distribution.** This retains fast development feedback but cannot detect changes in the final signed runtime or portable layout.

**Require a manual check before running Release.** Formal artifacts do not yet exist at that point, and the automated finalize job cannot establish that a later check ran.

**Trust only a successful packaging job.** An explicit receipt lets publication validate the accepted archive even after a partial workflow rerun or asset replacement.

## Consequences

The release adds one real upgrade scenario on its existing native packaging runner, reusing the pinned old release and existing assertions rather than creating another functional suite. Ordinary PR CI retains source-candidate upgrade coverage and lightweight gate regressions. Receipt rejection covers missing evidence, stale versions, different targets and changed bytes; signature and behavioral failures leave no success receipt. Local ad-hoc packaging validates mechanics but cannot satisfy the formal Developer ID and notarization requirement.
