# Decision Record: Agenda session-event triggers

Status: implemented

## Problem

GitHub issue #1217: Agenda only supported time-based triggers (cron/every/at/delay), file watches, and webhooks. Agents — especially boss agents — wanted to schedule work based on session/agent state, e.g. "when session 'research' ends this turn, tell me what he did and his conclusion". The existing `session.turn.after` plugin hook was not observable by internal runtime code, and `SessionEvent.Idle` fired only when a session's queue drained (coarse, and historically fragile when the trigger depended on a host session being active).

## Decision

Add a fourth agenda trigger source, `session`, alongside Clock / Watcher / Webhook, plus a turn-granularity Bus event to drive it:

- **`SessionEvent.TurnStart` / `SessionEvent.TurnEnd`** (`session/event.ts`) are published next to the existing `session.turn.after` plugin-hook call sites: processor normal path (start + end) and the three invoke error/abort paths (end). Both processor and invoke may publish for the same turn; consumers deduplicate by `messageID` (one turn = one assistant message).
- **`TriggerSession`** (`agenda/types.ts`): `{type:"session", sessionID, event:"turn.start"|"turn.end" (default turn.end), agent?, finish?, once (default true)}`. It joins the `Trigger` discriminated union and the `ScheduleTrigger` union exposed by `agenda_schedule`. `computeNextRunAt` produces no time candidate (event-driven, like watch/webhook); `updateRunState` treats `once:true` as auto-done after the first fire and `once:false` as recurring (persistent session mode).
- **`AgendaSessionTrigger`** (`agenda/session-trigger.ts`) subscribes via `Bus.subscribeGlobal` (items and watched sessions may live in different scopes), matches sessionID/event/agent/finish, deduplicates by messageID, and emits a `FiredSignal {type:"session", payload:{sessionID,messageID,finish,agent}}` into the shared Agenda handler. Registered/unregistered from `Agenda.syncItem`/`teardownItem` like the other sources.
- **Exposure**: `agenda_schedule` accepts the session trigger; `agenda_watch` gains a mutually exclusive `onSessionEnd` option (`delay` xor `onSessionEnd` enforced by a zod refine) that wakes the origin session when the watched session ends a turn (autoDone mode).
- The prompt builder renders the session trigger and a `<session-event>` payload block so the executing agent knows which session/turn/finish fired it.

## Alternatives considered

- **Reuse `SessionEvent.Idle`** — No new Bus event, but coarse granularity (idle ≠ one turn ended) and it recreated the fragile "depends on a host session being active" pattern from the delay/watch reliability lessons. Rejected; session triggers are event-driven and do not depend on clock ticks or host liveness.
- **Register Agenda as an internal plugin hook consumer of `session.turn.after`** — Would avoid a new event but couples Agenda to the plugin lifecycle and pollutes the plugin hook contract with an internal consumer. Rejected.
- **Polling the watched session's state with `agenda_watch`** — Slow, brittle, token-wasteful; exactly what the issue wanted to avoid. Rejected.

## Consequences

- Boss/agent sessions can now create one-shot or recurring automations keyed to another session's turn end/start, filtered by agent or finish state, with the fired signal injected into the execution prompt.
- The new Bus events are additive; existing consumers of `session.turn.*` observability are unaffected. `SessionAgendaTriggerType` grew a `"session"` value, which propagates to the generated SDK/OpenAPI (`./script/generate.ts`).
- Event loss is possible for turns that complete during process restart (same as webhooks); `Agenda.start()` reloads active items and re-subscribes on startup.
- A session trigger cannot watch "all sessions": `sessionID` is required, which also prevents an execution session's own TurnEnd from recursively re-triggering unrelated items.
