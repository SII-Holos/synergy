# Automation with Agenda

Agenda turns an instruction into durable triggered work. An Agenda item owns its activation rules, execution prompt, Scope, agent and model choices, control profile, session policy, delivery behavior, state, and run history.

Agenda is the right abstraction for work that starts because time passed, a schedule recurred, a file changed, a webhook arrived, or the user explicitly ran an existing item. Cortex delegation and workflow continuation are not Agenda triggers: they belong to work already in progress inside a session hierarchy.

## Item Lifecycle

An item moves through `pending`, `active`, `paused`, `done`, or `cancelled`. Active items are registered with the clock, file watcher, or webhook runtime according to their triggers. Paused, completed, and cancelled items do not fire.

Every item records:

- title, description, tags, and optional global visibility
- one or more triggers
- the prompt to run
- optional agent, model, control profile, session references, and timeout
- origin Scope, origin session, and endpoint context
- whether to wake the origin, remain silent, or complete after one delivery
- last and next run state, persistent session identity, error streak, and run count

Run history records the firing trigger, execution session, status, error, duration, and timestamps independently of the current item state.

## Triggers

The current trigger model supports:

- `at` — one Unix timestamp
- `delay` — one relative delay
- `cron` — a cron expression with optional IANA timezone
- `every` — a recurring duration with optional anchor
- `watch` — file add/change/unlink events matched by glob, with optional debounce
- `webhook` — an authenticated inbound HTTP trigger

The `agenda_schedule` agent tool exposes the four time-based trigger types. File watches have their own workflow. Webhooks are managed by the Agenda API and product surfaces. Polling commands and arbitrary tool-result watches are not active trigger types.

Multiple triggers can belong to one item. Deduplication compares their structural meaning so an equivalent automation is not accidentally registered twice.

## Execution Sessions

Agenda work is unattended. Unless explicitly overridden, its session uses the `autonomous` control profile, so execution never waits for an approval prompt.

Session mode is inferred from the trigger:

- `at` and `delay` default to `ephemeral`
- `cron`, `every`, and file `watch` default to `persistent`

An item can override that choice. A persistent item reuses its recorded Agenda session so context can accumulate across fires. An ephemeral item creates a dated session for one run and archives it after extracting the result.

Normal execution builds a trigger-aware prompt, invokes the selected agent, observes the item timeout, captures the final assistant text, updates run state, and delivers the result according to the item's notification settings.

`autoDone` is the exception used by one-shot watch-style delivery. It sends the item's prompt directly to the origin session instead of creating and invoking an Agenda session, then completes according to item state rules.

## Delivery

By default, a successful result is delivered back to the origin context. `silent` suppresses result delivery. `wake` controls whether completion may actively wake the origin session; Agenda sessions that can wake their origin receive a narrow `session_send` preauthorization.

Channel-origin Agenda items preserve endpoint context so results can return through the relevant connected surface rather than becoming detached local notifications.

Failures are retained in run history and increment the consecutive-error count. After five consecutive failures, the next activation auto-pauses the item instead of continuing an unattended failure loop. A successful run resets the streak.

## Built-in Autonomous Maintenance

On first startup, Agenda creates the home-scoped `anima-daily` item. It runs the hidden `anima` agent at 03:00 in `Asia/Shanghai` using a fresh ephemeral session, suppresses delivery, and does not wake another session. The agent can reflect on recent work and maintain knowledge or Agenda state through the tools available to its autonomous profile.

`library.autonomy` controls these background routines and defaults on. When it is off, the seed is created paused and active Anima items are paused. Explicitly turning autonomy on at runtime reactivates paused Anima items; an ordinary startup with autonomy already on does not override a user's manual pause. Anima is a host-owned routine, not a primary agent exposed in the session selector.

## Product Surfaces

The Agenda UI presents calendar/schedule state, item editing, status controls, execution history, and related sessions. Agents can create and manage supported time triggers with Agenda tools. Plugins can inspect or alter execution through `agenda.run.before`, `agenda.run.after`, and `agenda.run.error` hooks.

## Invariants

- Agenda owns triggered future work; it does not represent an active child task.
- Every run executes in the Scope captured by the item origin.
- Unattended sessions cannot pause for user approval.
- Persistent and ephemeral session policies are explicit and observable.
- Run history survives changes to the current schedule state.
- Repeated failures stop automatically instead of retrying forever without intervention.
