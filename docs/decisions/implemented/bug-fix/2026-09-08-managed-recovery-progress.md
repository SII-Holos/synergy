# Decision Record: Keep managed startup alive during execution-history recovery

Status: implemented

## Problem

Execution-history recovery replays committed journals before the runtime opens HTTP admission. Migration completion does not imply this recovery is complete. A fixed health deadline can terminate a healthy recovery on a large existing home, while fresh-home startup checks pass.

## Decision

Harness reports aggregate recovery work before scanning and after checking owners, journal records, projections and committed evidence chunks. Product Runtime emits throttled startup records for managed Desktop. Desktop permits recovery after migration completion, extends its inactivity deadline only for advancing counts, and restores its bounded health wait after successful recovery. Failed recovery never reports completion. Recovery records contain counts only, without session identities, paths or payloads.

## Alternatives considered

**Increase the fixed health timeout.** This gives every failed startup a longer silent wait and still imposes an arbitrary upper limit on legitimate recovery.

**Open HTTP admission before recovery or skip historical replay.** This changes the single-writer recovery guarantee and requires a separately designed consistency mechanism; it is unnecessary to correct the startup waiting policy.

## Consequences

Large journals remain subject to their existing replay cost, with visible progress instead of premature termination. Startup waits remain finite when work stalls. The optional observer adds no persisted state, migration or recovery shortcut. Regression coverage exercises phase transitions, actual storage recovery, failure propagation, output throttling and Electron presentation.
