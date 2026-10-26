# Decision Record: Admit real released upgrades and native signing evidence

Status: implemented

## Problem

Source migration fixtures and fresh installed-package tests do not establish that an actual released binary's data can be upgraded. Platform-skipped signing tests can also report a successful suite without testing macOS byte mutation. Neither signal is sufficient to prepare the 3.1.0 release.

## Decision

The released-upgrade verifier downloads a pinned 3.0.22 archive, verifies its SHA256 before extraction, and executes that release and the built candidate outside the checkout. The scenario creates real history, tool effects, an approved process plugin, an image attachment and persisted locale configuration through public APIs. It checks retained evidence, old-task continuation, restart, fresh work, then actual 3.0.22 execution after restoring the complete pre-upgrade Home. A deterministic provider substitutes only model inference.

CI adds one consumer of its existing Linux full distribution and keeps its actual build version. The verifier requires exactly one passing named JUnit scenario; missing inputs, download errors, changed digests, failures and skips fail admission. macOS executes the real signing tests in its existing native pool and requires all native scenarios to pass. Ordinary suites exclude these controls rather than executing skipped or duplicate copies. The existing required aggregate owns both results.

## Alternatives considered

**Synthesize an old Home using current source.** That skips released serialization, configuration, packaging and bootstrap behavior.

**Treat fresh-install or health checks as upgrade evidence.** They do not execute retained plugins, read old attachments, continue old work or prove restart and backup recovery.

**Add separate workflows and rebuild the candidate for each check.** The existing distribution producer and macOS pool already own those prerequisites; duplicate builds increase cost and can test different bytes.

**Permit absent artifacts or skipped controls locally or in CI.** Such success cannot distinguish an untested release from a passing one. The explicit verifier rejects both.

## Consequences

The historical archive adds a pinned download and real runtime execution, not another candidate build. The initial planner weights are estimates; hosted preparation, execution, upload and queue costs remain measured CI evidence. Local native signing fixtures do not replace full application packaging, Developer ID/notarization or native OS permission checks. Linux x64 and macOS arm64 are the released-upgrade verifier's supported hosts; other platforms keep their separate packaging and installation checks. The [runbook](../../../operations/desktop-release.md#released-upgrade-acceptance) owns commands and limitations.
