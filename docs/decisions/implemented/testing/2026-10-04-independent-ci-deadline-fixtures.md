# Decision Record: Independent CI deadline fixtures

Status: implemented

## Problem

Native worker tests can mix a compressed wall timer with a simulated monotonic deadline. Advancing the clock past a healthy probe's deadline makes exact timeout counts depend on whether real IPC beats a ten-millisecond timer. A production-host browser test that combines throttled history recovery with unrelated settings persistence also spends one deadline on two independently verifiable behaviors.

## Decision

The SQLite suspension fixture advances its simulated clock for deliberately unanswered requests. The healthy probe retains its monotonic budget while its real response is delayed beyond a compressed wall tick. Exact timeout counts, probe counts, busy reporting, continued query service and cleanup remain asserted. Teardown verifies closed admission after the bounded close and awaits the actual worker exit before asserting its signal status. Product storage deadlines and worker behavior are unchanged.

Production-host conversation history and preference persistence use separate tests with fresh Homes and browser contexts. The history case retains 360 turns, CPU and network throttling, pagination limits, search, reconnect and reload assertions. Its complete sequential workflow has a three-minute test deadline, with unchanged twenty-second interaction deadlines and elapsed-time diagnostics at each completed stage. Hosted runs exhausted the aggregate ninety-second budget at different late stages while the same continuous workflow completed locally; the outer budget must cover all stages without extending an individual failed interaction. The settings case retains display mode, workspace preference and notification persistence through a real save and reload within ninety seconds.

The activity layout acceptance asserts the adopted 32px desktop row geometry from the [semantic process disclosure decision](../feature/2026-10-04-semantic-process-disclosure.md), preserving all spacing and keyboard checks.

Browser fixture bootstrap completes under its setup deadline before short interaction deadlines begin. Each fresh work-context page has a separate fifteen-second navigation budget within the existing test deadline; component interactions retain their four-second budget. Preloading modules does not guarantee that subsequent page loads finish within an interaction deadline on a shared runner. Markdown identity acceptance enables CPU throttling after the fixture has loaded, then acquires the actual mounted Markdown element, waits for the final visible state and still requires the same connected node after disclosure exit. Throttled streaming, terminal settlement and disclosure remain the measured behavior; fixture module startup does not consume their capacity. Separate captured, connected and identity assertions retain diagnostic evidence for transient failures. Virtualized location checks observe the current target and its scroll owner in one bounded readiness predicate, avoiding detached handles during layout reconciliation while still requiring the target to intersect its owning viewport.

## Alternatives considered

**Allow extra timeout metrics.** This would weaken the observed guarantee and hide fixture scheduling races.

**Increase the combined browser timeout.** This would continue coupling unrelated scenarios and reduce failure localization.

**Remove throttling or reduce history.** This would stop exercising the conditions that the conversation acceptance exists to verify.

## Consequences

The browser suite pays for one additional isolated preview startup. Native timer tests remain sensitive to incorrect deadline decisions without depending on host IPC speed. These changes alter verification fixtures rather than product behavior.
