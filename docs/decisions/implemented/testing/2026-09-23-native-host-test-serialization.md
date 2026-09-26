# Decision Record: Serialize independent package tests on each native host

Status: implemented

## Problem

Workspace admission coordinates real filesystem use across Runtime homes and processes on one host. An unconfined native command legitimately blocks an unrelated exclusive binding change. Independent package test processes running concurrently on one CI runner can therefore invalidate each other's idle-host fixture assumptions, even with separate test homes.

## Decision

Each test shard runs its package tasks with Turbo concurrency one. Shards retain separate runners, every package remains assigned exactly once, and explicit concurrency tests within suites still exercise multiple Runtime instances, native descendants and competing operations. Product admission deadlines and test assertions remain unchanged.

## Alternatives considered

**Separate only Runtime homes.** Host-wide native filesystem effects deliberately cross those homes, so that does not isolate unconfined writers.

**Increase binding deadlines or retry fixture mutations.** This hides accidental competing test processes and changes what a failed admission means. It does not establish the idle-host precondition.

**Give each package a separate runner.** This provides stronger process isolation but multiplies dependency installation and native helper setup. Existing shards can serialize their package tasks while preserving parallelism between hosts.

## Consequences

Package tests on one runner take their combined elapsed time. The complete matrix and required fan-in checks remain intact. A controlled native Linux process holding an unconfined write claim reproduced the browser fixture's one-second busy failure; after the process exited, the unchanged test passed. This establishes the interference mechanism but does not identify the exact holder in the original CI run, whose grouped logs contain no ownership snapshot. The [sharding record](../process/2026-09-09-ci-test-and-coverage-sharding.md) remains authoritative for package assignment and aggregation.
