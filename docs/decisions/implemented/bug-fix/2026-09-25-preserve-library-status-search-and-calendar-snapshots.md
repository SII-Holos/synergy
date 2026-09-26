# Decision Record: Preserve Library status, search and calendar snapshots

Status: implemented

## Problem

The inspection surface dropped persisted experience status, left failed details loading indefinitely and rendered source labels without values. Sparse activity buckets were sliced by row count, so a fourteen-day view could contain older dates. Library refresh could clear the displayed data and recompute twice.

## Decision

Expose reward status in experience list, detail and search DTOs. Keep failed, pending and evaluated records distinct without deriving state from nullable or zero rewards. Show source values and session links, retain cards during detail failures and move evaluation metrics into secondary disclosures. Native buttons expose card and calendar actions to keyboard users without nesting secondary controls.

Open Library on unified search and recent content, keeping statistics on a separate tab. Query ownership and independent content-group loaders prevent obsolete responses or one failed group from replacing other results. Recent experiences use a server-side updated-time sort; Skills have no fabricated update timestamps. Home Skill discovery passes a nullable Workspace path to the canonical source resolver, allowing global and built-in entries without inventing a project directory. Global archive operations retain the same canonical-root checks. Read-only detail retry remains separate from model-backed encoding maintenance.

Keep successful statistics snapshots on refresh failure and label their computation time. Calendar ranges end on the snapshot date, include missing dates and retain local calendar labels. The generated Library statistics response describes both summary and analytics results, replacing the client’s duplicated type.

## Alternatives considered

**Infer status from reward or intent.** A zero reward is a valid evaluated outcome and missing intent does not identify the persisted failure state.

**Display the last N active dates.** This conflicts with calendar-day range labels and can move old activity into a recent window.

**Clear everything on refresh.** This discards useful evidence and couples independent failures. Retaining results only within the same query preserves context without showing another query’s matches.

Selection indicators sit inside each card’s labeled native toggle, so clicking the visible checkbox and pressing Enter or Space update the same selection. Browser regression fixtures load the product styles to exercise the actual hit targets.

## Consequences

API tests cover persisted status and updated-time pagination. Browser tests cover keyboard activation, source links, detail retries, partial search failure and calendar actions. Resource tests cover stale responses, cancellation and retained snapshots; date tests cover sparse, empty, leap-day and year-boundary intervals. Existing encoding and reward policies are unchanged.
