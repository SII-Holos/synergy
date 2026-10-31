# Decision Record: Preserve workspace saves across snapshot size omissions

Status: implemented

## Problem

A previously recorded file can grow beyond the per-file history capture limit. Object Workspace evidence captures both saved manifests without collecting omissions, so history capture rejects the operation after durable Workspace publication. Simply omitting the bytes also makes a missing snapshot entry look like a deletion.

## Decision

Operation evidence collects omissions separately at each endpoint and persists them on complete patch operations. Its file list excludes either endpoint's omitted paths. Snapshot ranges propagate those omissions through summaries, history comparison and restore selection. Complete operation evidence cannot enter the legacy patch fallback after range filtering. Old operations without these optional fields retain their existing meaning; there is no invented omission history or state rewrite.

The [Workspace architecture](../../../architecture/workspace-and-files.md) owns the capture policy. Workspace manifests and chunks remain complete; only historical capture is limited. Object-storage, integrity and snapshot-publication errors retain their failure semantics.

## Alternatives considered

**Raise or remove the capture limit.** This moves the failure threshold or removes the bounded history-read guarantee without addressing growth.

**Delete oversized Workspace files.** This discards working data and confuses optional history with durable Workspace ownership.

**Ignore every snapshot exception.** This hides corruption and storage failures. Explicit omissions identify the limited historical capability without claiming that failed persistence succeeded.

## Consequences

Tasks can settle after files exceed history limits, and fresh Environments still restore those bytes. A file omitted at either chosen endpoint has no complete comparison or restore pair. A later fully captured pair can restore normal history support. Existing recorded small versions remain retained. Optional operation fields preserve old-record reads and export/import through the existing Message schema; consumers must understand omission metadata before presenting complete history.
