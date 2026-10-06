# Decision Record: Resume the complete Environment release

Status: implemented

## Problem

A provider can remove compute and then fail before retiring its network, staging volume or credentials. Inspection may correctly report absent compute while the durable Environment still owns an unfinished release. Treating that observation as completed release discards its allocation identity and strands residual resources. Startup recovery also lost the release intent when a checkpoint failed again.

## Decision

A releasing Environment resumes its existing resource-owner checkpoints and provider deallocation before ordinary availability inspection. Only successful completion clears its allocation and active index. Failed startup recovery preserves the releasing state and original request identity so maintenance can retry. Checkpoint failure still prevents provider destruction; lost live Workspaces retain their existing unavailable-state handling.

## Alternatives considered

Inferring complete retirement from absent compute cannot account for resources that outlive it. Teaching each host to remove leftover resources duplicates provider ownership and risks deleting unsaved files. Retrying the existing release keeps both saving and physical cleanup with their owners, without a new state or migration.

## Consequences

Provider deallocation and resource checkpoints remain idempotent for one allocation. Reconciliation does not allocate replacement compute or discard uncertain output. SQLite and PostgreSQL tests cover repeated checkpoint and provider failures, startup recovery and later maintenance. A Docker test drops the successful container-deletion response, then verifies saved bytes and actual volume/network retirement. See the [postmortem](../../../postmortem/0049-absent-compute-lost-release-intent.md).
