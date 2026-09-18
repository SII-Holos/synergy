# Decision Record: Honest countdowns — real anchors, accurate labels, and the bash timing argument

Status: implemented

## Problem

Four defects made the tool-card time display disagree with what the runtime actually does. They shared one cause: every layer held its own belief about what a window meant.

**The bash metadata read argument names the model cannot send.** `packages/harness/src/tool/timeout.ts` read `args.backgroundAfterSeconds` and `args.timeoutSeconds`, but the model-facing bash schema is `.strict()` and exposes only `yieldSeconds`. The `backgroundAfterSeconds` mapping happened _after_ metadata was computed. So a call carrying `yieldSeconds: 300` produced `displayMs: 30_000`, while the non-schema name was the only thing that could change the value. Live session data confirmed the mismatch: input `yieldSeconds: 300`, stored `displayMs: 30_000`, actual runtime 253 seconds — the badge stalled at `0s timeout` while the command kept running for another 223 seconds.

The same mistake ran in reverse in the prompts: `developer/base.txt` instructed the model to set `backgroundAfterSeconds` and `timeoutSeconds`. Because the schema is strict, following that instruction is a hard validation error, not a silent no-op.

**The countdown fabricated its own anchor.** `countdown.tsx` evaluated `const fallbackStartedAt = Date.now()` at component construction and used it whenever `startedAt` was absent. A countdown is a claim about elapsed time; mount time is not that claim's origin. Any remount — switching sessions, collapsing and expanding a card — restarted a 300-second window from full. The clearest instance was the question card, which never passed `startedAt` at all despite `request.createdAt` already being in the SDK payload: with a one-hour default, toggling the card reset the countdown.

**Expiry kept rendering a live-looking number.** The remaining value clamped to zero and the label kept saying `0s timeout` forever, distinguishable from a settled tool only by a color shift.

**The label described the wrong event.** Renderers read only `displayMs` and ignored `source`, so an `auto_background` window — which hands the process to the background and leaves it running — was labelled `Ns timeout`. `source` had ten members and zero consumers.

## Decision

Each fix lives at the layer that owns the fact.

**The producer reads what the model can actually send.** The bash branch of `operationForTool` reads `yieldSeconds` and yields an `auto_background` window; the `wait` branch and the command-timeout comparison are gone. `timeoutSeconds` is removed end to end — schema, `BashParams`, the local executor's command timer, the remote strip list, and all three prompt files — leaving the 24-hour hard ceiling as the only forced termination. It was never reachable by the model, so nothing in use was removed; a half-present capability that prompts advertise and the schema rejects is worse than no capability.

The local executor's default now references `ToolTimeout.DEFAULTS.bashAutoBackgroundMs` instead of repeating a literal `30`, eliminating the third independent copy of that number. The bash description and tool schema were corrected from "Default: 10" to the actual 30 seconds, which no code change could have caught.

**No anchor means no countdown.** `toolCountdown` returns `undefined` when `time.start` is missing, and `Countdown` renders nothing without a finite `startedAt`. The `Date.now()` fallback is deleted rather than guarded. `pending` and `generating` carry no `time` in the tool-state schema, and those states did not display a countdown before either — so honest absence costs no real information and removes the only path that invented one.

**The label follows the window's meaning.** `toolCountdown` maps `source` to a `kind`: `auto_background` → "to background", `tool_timeout` → "to timeout", everything else — including a missing or unknown source from historical parts — → "remaining". Expiry renders a terminal label per kind (`backgrounded` / `timed out` / `past limit`) instead of a live-looking zero, so the display distinguishes "the window closed" from "the tool is still working".

**Question cards use the anchor the server already sends.** `question-prompt.tsx` passes `startedAt={request.createdAt}`.

Agent-facing time parameters on non-generated schemas were renamed to `timeoutSeconds` with second-valued bounds and defaults, matching the producer's read names. Absent an anchor the interval now also stops when inactive instead of ticking and discarding.

## Alternatives considered

- **Add a typed `time` to `pending` and `generating` so those states can show a countdown** — rejected for this change: it alters `ToolState` in `packages/sdk/openapi.json` and the generated SDK, and creates a compatibility question for parts already stored without the field. Those states showed no countdown beforehand, so the honest-absence rule achieves the same truthfulness with no contract change.
- **Keep `timeoutSeconds` and extend the Synergy Link protocol to carry it** — rejected: it requires a `.strict()` protocol change, remote host work, and cross-version coordination to finish a feature the model could never invoke. Removing it leaves local and remote behavior identical, which is what the prompts claimed all along.
- **Rename the internal `displayMs` / `toolTimeoutMs` fields to seconds** — rejected: they are persisted on parts and read back from history; renaming strands the observation on every stored part and needs a migration. They are not agent- or human-facing.
- **Replace the countdown with elapsed-time display** — rejected: it is honest but discards the user's only signal for when a command will background or abort.
- **Share one 1 Hz ticker across countdowns** — rejected: the existing shared source lives in `apps/web`, and moving it into `packages/ui` would change a shared component's ownership and lifecycle for a negligible saving. Stopping the interval while inactive addresses the actual waste.
- **Keep `backgroundAfterSeconds` as an accepted alias** — rejected: two names for one argument is the defect being removed, and a strict schema turns the old name into an explicit error, which is the correct failure mode.

## Consequences

- A call's displayed window now matches the window the runtime enforces, and the bash metadata follows the model's actual input for the first time.
- Countdowns no longer survive their own absence: fewer badges render, and the ones that do are anchored to server time. Session switches no longer restart a window.
- `source` became load-bearing, so the ten-member union is now part of the render contract rather than dead data.
- Bash lost a command-level termination control that no model could reach and that the remote path already discarded. The 24-hour hard ceiling and the abort path are unchanged, so no enforced limit was weakened.
- `browser_wait`'s floor moved from 500 ms to 1 s as a consequence of stating the parameter in seconds — a deliberate resolution trade recorded in the tool description.
- The prompts, the schema, the executor, and the metadata builder now state one contract instead of four.
