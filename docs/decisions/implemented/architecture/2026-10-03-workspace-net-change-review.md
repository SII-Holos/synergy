# Decision Record: Workspace net change review and confirmed restoration

Status: implemented

## Problem

Summing per-tool patches counted intermediate edits repeatedly, omitted changes from concurrent writers and made successful work appear incomplete when authorship could not be proved. Reviewing an operation was also easily confused with reviewing the whole turn. Unconditional restoration could overwrite edits made after a user inspected a Diff.

## Decision

Session records actual workspace contents at execution-segment boundaries in versioned system checkpoint parts. Turn and session summaries compare immutable endpoints, grouped by Workspace identity and binding generation, including every writer in the interval. Capturing a workspace is independent of tool outcome and does not alter the user's Git index. Existing Snapshot retention, transfer and collection retain these endpoints. Concrete tool evidence remains a separate tool-domain responsibility.

Settlement separates pending, ready, partial and error. Missing baselines cannot be reconstructed from later files. Captured omissions exclude affected paths from comparison and restore authority while preserving valid results. UI cards and Review consume these projections without inferring filesystem state from activity labels. Historical expansion reads retained versions rather than current files.

Coverage belongs to the compared endpoints. Baseline and endpoint omissions are retained separately; an intermediate capture failure does not invalidate a later complete first-to-last comparison. The failed checkpoint remains unchanged in history. A missing first baseline remains incomplete after continuation.

Restoration requires a current-to-baseline preview and an explicit confirmation identity. Local Runtime validates Workspace and entry/content versions before atomic writes. Durable session receipts return the same completed result on repeated submission; interrupted or expired previews require a new comparison. File restoration remains independent of conversation rollback.

This replaces the file-summary attribution rule in [Workspace operation coordination](2026-09-29-workspace-operation-coordination.md); that decision's process ownership, resource admission and concrete mutation rules continue to apply.

## Alternatives considered

**Per-tool whole-workspace capture.** Cost grows with tool count, and arbitrary concurrent processes cannot be assigned reliably to a particular tool. Operation evidence still serves tools that can supply it directly.

**Git working-tree status as history.** It uses a repository baseline rather than the user's actual pre-turn contents, cannot represent non-Git workspaces and changes meaning after later edits or commits.

**Restore the original Diff without another preview.** The live file may have changed since the captured endpoint. A fresh preview with version checks makes the destructive effect explicit and prevents silent replacement of later work.

## Consequences

Normal capture cost is two scans per participating workspace per execution segment, independent of the number of tool calls. Net results remove reverted edits and repeated line counts. A capture is a bounded traversal, not a transactional snapshot of unrelated external processes; files that cannot be read consistently remain explicit omissions. Background activity can continue beyond a frozen endpoint and appears only in a later checkpoint.

Old operation endpoints remain available but cannot prove a complete turn baseline. Prepared restore receipts have a bounded lifetime and do not survive Runtime authority changes; complete receipts remain replayable without additional writes. Multi-file restoration may partially complete, so callers must preserve per-file outcomes instead of claiming one global success.
