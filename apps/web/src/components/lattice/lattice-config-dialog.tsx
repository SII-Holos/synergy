import { createSignal, onMount, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { SDKContext } from "@/context/sdk"
import {
  pauseReasonLabel,
  RUN_STATUS_DESCRIPTORS,
  runWorkState,
  workStateLabel,
  type LatticeMode,
  type LatticeRunView,
} from "./lattice-panel-model"

export type { LatticeMode } from "./lattice-panel-model"

export interface LatticeEnableConfig {
  mode: LatticeMode
  maxModelCalls: number
  goal?: string
}

function progressCounts(run: LatticeRunView): { done: number; total: number } {
  return {
    done: run.pathway.filter((step) => step.status === "completed").length,
    total: run.pathway.length,
  }
}

export function LatticeConfigDialog(props: {
  sdk: SDKContext
  sessionID?: string
  onEnable: (config: LatticeEnableConfig) => Promise<void> | void
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const [existing, setExisting] = createSignal<LatticeRunView | null>(null)
  const [loading, setLoading] = createSignal(!!props.sessionID)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [mode, setMode] = createSignal<LatticeMode>("auto")
  const [budget, setBudget] = createSignal("0")
  const [goal, setGoal] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const modeLabel = (value: LatticeMode) =>
    value === "auto"
      ? _({ id: "app.lattice.config.mode.auto", message: "Advance autonomously" })
      : _({ id: "app.lattice.config.mode.collaborative", message: "Work with you" })

  onMount(async () => {
    if (!props.sessionID) return
    try {
      const result = await props.sdk.client.lattice.session.getRun({ id: props.sessionID })
      const run = result.data ?? null
      setExisting(run)
      if (run) {
        setMode(run.mode)
        setBudget(String(run.maxModelCalls))
      }
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  })

  const canSubmit = () => {
    const run = existing()
    return (
      !run ||
      run.status === "active" ||
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    )
  }

  const submit = async () => {
    if (!canSubmit()) return
    setSaving(true)
    try {
      const parsedBudget = Math.max(0, Math.floor(Number(budget()) || 0))
      const current = existing()
      const startsNewRun =
        !current || current.status === "completed" || current.status === "failed" || current.status === "cancelled"
      await props.onEnable({
        mode: mode(),
        maxModelCalls: parsedBudget,
        goal: props.sessionID && startsNewRun ? goal().trim() || undefined : undefined,
      })
      dialog.close()
    } catch (error) {
      showToast({
        type: "error",
        title: _({ id: "app.lattice.config.failed", message: "Failed to configure Lattice" }),
        description:
          error instanceof Error
            ? error.message
            : _({ id: "app.lattice.config.unknownError", message: "Unknown error" }),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={_({ id: "app.lattice.config.title", message: "Configure Lattice" })} size="form">
      <div data-slot="dialog-form" class="flex min-w-0 flex-col">
        <p class="text-12-regular text-text-weak">
          {_({
            id: "app.lattice.config.description",
            message:
              "Lattice aligns requirements, plans a Pathway, reviews each Blueprint, and delegates execution to BlueprintLoop. Work with you waits for explicit approval before execution.",
          })}
        </p>

        <Show when={!props.sessionID}>
          <p class="mt-2 text-11-regular text-text-weak">
            {_({
              id: "app.lattice.config.nextMessageGoal",
              message: "Your next message will start requirement alignment for this run.",
            })}
          </p>
        </Show>

        <Show when={loading()}>
          <div class="mt-4 text-11-regular text-text-weak" role="status" aria-live="polite">
            {_({ id: "app.lattice.config.loading", message: "Loading previous Lattice run…" })}
          </div>
        </Show>
        <Show when={loadFailed()}>
          <div class="mt-4 text-11-regular text-text-on-critical-base" role="alert">
            {_({ id: "app.lattice.config.loadFailed", message: "Could not load the previous Lattice run." })}
          </div>
        </Show>

        <Show when={!loading() && existing()}>
          {(run) => {
            const state = () => runWorkState(run())
            return (
              <section class="mt-5 border-y border-border-weaker-base py-4">
                <div class="text-11-medium uppercase tracking-wide text-text-weak">
                  {_({ id: "app.lattice.config.previousRun", message: "Previous run" })}
                </div>
                <div class="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-13-medium text-text-strong">
                  <span>{_(RUN_STATUS_DESCRIPTORS[run().status])}</span>
                  <Show when={state()}>
                    {(value) => <span class="text-text-weak">{workStateLabel(_, value())}</span>}
                  </Show>
                  <span class="text-text-weak">{modeLabel(run().mode)}</span>
                </div>
                <Show when={run().status === "paused"}>
                  <div class="mt-1 text-11-regular text-text-on-warning-base">
                    {pauseReasonLabel(_, run().statusReason)}
                  </div>
                </Show>
                <div class="mt-2 text-11-regular text-text-weak">
                  {_({
                    id: "app.lattice.config.stepsCompleted",
                    message: "{done}/{total} steps completed",
                    values: progressCounts(run()),
                  })}
                  <Show when={run().currentStepID}>
                    {" · "}
                    {_({ id: "app.lattice.config.current", message: "Current" })}:{" "}
                    {run().pathway.find((step) => step.id === run().currentStepID)?.title ??
                      _({ id: "app.lattice.config.notStarted", message: "Not started" })}
                  </Show>
                </div>
                <div class="mt-1 text-11-regular text-text-weak">
                  {_({ id: "app.lattice.config.modelCalls", message: "Model calls" })}: {run().modelCallCount}/
                  {run().maxModelCalls || _({ id: "app.lattice.config.unlimited", message: "Unlimited" })}
                </div>
                <Show when={run().status === "paused"}>
                  <p class="mt-3 text-11-regular leading-4 text-text-weak">
                    {_({
                      id: "app.lattice.config.pausedHint",
                      message: "Resume or cancel this run from the Lattice panel before changing its settings.",
                    })}
                  </p>
                </Show>
              </section>
            )
          }}
        </Show>

        <section class="py-5">
          <span class="text-12-medium text-text-strong">
            {_({ id: "app.lattice.config.mode", message: "How Lattice runs" })}
          </span>
          <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              aria-pressed={mode() === "auto"}
              class="flex min-h-11 items-center gap-3 rounded-md border border-border-weak-base bg-surface-inset-base px-3 py-2 text-left text-12-medium text-text-base hover:border-border-strong-base"
              classList={{ "border-border-strong-base bg-surface-raised-base text-text-strong": mode() === "auto" }}
              onClick={() => setMode("auto")}
              disabled={saving() || existing()?.status === "paused"}
            >
              <span
                class="size-2 rounded-full border border-border-strong-base"
                classList={{ "bg-text-strong": mode() === "auto" }}
              />
              {modeLabel("auto")}
            </button>
            <button
              type="button"
              aria-pressed={mode() === "collaborative"}
              class="flex min-h-11 items-center gap-3 rounded-md border border-border-weak-base bg-surface-inset-base px-3 py-2 text-left text-12-medium text-text-base hover:border-border-strong-base"
              classList={{
                "border-border-strong-base bg-surface-raised-base text-text-strong": mode() === "collaborative",
              }}
              onClick={() => setMode("collaborative")}
              disabled={saving() || existing()?.status === "paused"}
            >
              <span
                class="size-2 rounded-full border border-border-strong-base"
                classList={{ "bg-text-strong": mode() === "collaborative" }}
              />
              {modeLabel("collaborative")}
            </button>
          </div>
        </section>

        <div class="border-t border-border-weaker-base py-5">
          <TextField
            label={_({ id: "app.lattice.config.budget", message: "Model-call budget" })}
            description={_({
              id: "app.lattice.config.budgetDescription",
              message:
                "The budget is checked before Lattice continues; it counts model calls in this Lattice session, not Pathway steps. Enter 0 for no budget.",
            })}
            type="number"
            value={budget()}
            onChange={setBudget}
            disabled={existing()?.status === "paused"}
          />
        </div>

        <Show
          when={
            !!props.sessionID &&
            (!existing() ||
              existing()?.status === "completed" ||
              existing()?.status === "failed" ||
              existing()?.status === "cancelled")
          }
        >
          <div class="border-t border-border-weaker-base py-5">
            <TextField
              label={_({ id: "app.lattice.config.goalOptional", message: "Goal (optional)" })}
              type="text"
              placeholder={_({
                id: "app.lattice.config.goalPlaceholder",
                message: "What should this Lattice run accomplish?",
              })}
              value={goal()}
              onChange={setGoal}
            />
          </div>
        </Show>

        <div class="flex flex-wrap justify-end gap-2 border-t border-border-weaker-base pt-4">
          <Show when={canSubmit()}>
            <Button variant="primary" onClick={() => void submit()} disabled={saving() || loading() || loadFailed()}>
              {!props.sessionID
                ? _({ id: "app.lattice.config.arm", message: "Arm Lattice for this message" })
                : existing()?.status === "active"
                  ? _({ id: "app.lattice.config.save", message: "Save settings" })
                  : existing()
                    ? _({ id: "app.lattice.config.startNew", message: "Start new run" })
                    : _({ id: "app.lattice.config.enable", message: "Enable Lattice" })}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
