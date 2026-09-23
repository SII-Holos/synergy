# Decision Record: Isolate browser mocks and give Harness its own coverage budget

Status: implemented

## Problem

The Web browser-condition batch shared one Bun process between theme lifecycle tests and the built-in Library loader test. Their module mocks replaced different exports of the router, server and theme modules, so import order could make another suite fail before its assertions. Selecting browser conditions did not isolate the module registry.

The core-server coverage group also exceeded its 20-minute runner budget. In [the failed CI run](https://github.com/SII-Holos/synergy/actions/runs/35746053019), report timestamps show CLI and Connections completing before Harness consumed approximately 12 minutes. Plugin Host completed next, and the server reports were still being generated when the job was cancelled. This was progressing serial work exceeding a shared budget.

## Decision

The three Web suites run individually through the existing isolated-test list while retaining browser conditions. Their assertions and coverage collection remain unchanged.

Harness has a dedicated coverage matrix entry. The other four packages retain the core-server group, making five groups overall. Every manifest package still runs exactly once, and the aggregate job still requires every group and evaluates the union of all reports. The 20-minute job timeout and coverage thresholds remain unchanged. The [coverage sharding decision](../process/2026-09-09-ci-test-and-coverage-sharding.md) defines aggregation and required-check ownership.

## Alternatives considered

**Add missing exports to each mock or depend on test order.** A fake intended for one suite would still replace another suite's dependencies, making unrelated tests responsible for coordinating mock behavior.

**Increase the combined coverage timeout.** The observed work separates at an existing package process boundary, so a dedicated runner removes the cumulative deadline pressure without extending the failure-detection budget.

## Consequences

Web tests add three short-lived processes and coverage uses one additional runner. The suite assertions, source coverage accounting and required checks remain intact. The matrix regression verifies Harness isolation in addition to complete, non-overlapping package assignment; the existing runner regression verifies browser conditions and separate coverage output for isolated suites.
