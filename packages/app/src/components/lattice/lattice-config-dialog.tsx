import { createSignal, onMount, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { LatticeRun } from "@ericsanchezok/synergy-sdk/client"

export type LatticeMode = "auto" | "collaborative"

export interface LatticeEnableConfig {
  mode: LatticeMode
  maxModelCalls: number
  goal?: string
  action?: "continue" | "restart"
}

export interface LatticeConfigSDK {
  client: {
    lattice: {
      session: {
        getRun: (input: { id: string }) => Promise<{ data?: LatticeRun | null }>
      }
    }
  }
}

const RESUMABLE = new Set(["paused"])

function progressCounts(run: LatticeRun): { done: number; total: number } {
  const pathway = run.pathway ?? []
  return {
    done: pathway.filter((step) => step.status === "completed").length,
    total: pathway.length,
  }
}

function statusLine(run: LatticeRun, modeLabel: string): string {
  const reason = run.statusReason ? ` (${run.statusReason})` : ""
  return `${run.status}${reason} · ${run.phase} · ${modeLabel}`
}

export function LatticeConfigDialog(props: {
  sdk: LatticeConfigSDK
  sessionID?: string
  onEnable: (config: LatticeEnableConfig) => Promise<void> | void
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const [existing, setExisting] = createSignal<LatticeRun | null>(null)
  const [loading, setLoading] = createSignal(!!props.sessionID)
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
      // No prior run — fresh configuration.
    } finally {
      setLoading(false)
    }
  })

  const canContinue = () => {
    const run = existing()
    return !!run && RESUMABLE.has(run.status)
  }

  const submit = async (action?: "continue" | "restart") => {
    setSaving(true)
    try {
      const parsedBudget = Math.max(0, Math.floor(Number(budget()) || 0))
      await props.onEnable({
        mode: mode(),
        maxModelCalls: parsedBudget,
        goal: props.sessionID ? goal().trim() || undefined : undefined,
        action,
      })
      dialog.close()
    } catch (err) {
      showToast({
        type: "error",
        title: _({ id: "app.lattice.config.failed", message: "Failed to enable Lattice" }),
        description:
          err instanceof Error ? err.message : _({ id: "app.lattice.config.unknownError", message: "Unknown error" }),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={_({ id: "app.lattice.config.title", message: "Configure Lattice" })} size="form">
      <div data-slot="dialog-form" class="flex flex-col gap-4">
        <p class="text-12-regular text-text-weak">
          {_({
            id: "app.lattice.config.description",
            message:
              "Lattice turns your goal into an ordered Pathway and executes each step through a BlueprintLoop. Advance autonomously keeps planning and executing without waiting for review. Work with you pauses before each Blueprint executes so you can review it or add instructions.",
          })}
        </p>

        <Show when={!props.sessionID}>
          <p class="text-11-regular text-text-weak">
            {_({
              id: "app.lattice.config.nextMessageGoal",
              message: "Your next message will be used as the goal for this run.",
            })}
          </p>
        </Show>

        <Show when={!loading() && existing()}>
          {(run) => (
            <div class="rounded-lg border border-border-base/60 bg-surface-weak/40 p-3">
              <div class="text-11-medium text-text-weak uppercase tracking-wide">
                {_({ id: "app.lattice.config.previousRun", message: "Previous run" })}
              </div>
              <div class="mt-1 text-12-medium text-text-strong">{statusLine(run(), modeLabel(run().mode))}</div>
              <div class="mt-1 text-11-regular text-text-weak">
                {_({
                  id: "app.lattice.config.stepsCompleted",
                  message: "{done}/{total} steps completed",
                  values: progressCounts(run()),
                })}
                <Show when={run().currentStepID}>
                  {" · "}
                  {_({ id: "app.lattice.config.current", message: "current" })}:{" "}
                  {(run().pathway ?? []).find((s) => s.id === run().currentStepID)?.title ?? run().currentStepID}
                </Show>
              </div>
              <div class="mt-1 text-11-regular text-text-weak">
                {_({ id: "app.lattice.config.modelCalls", message: "Model calls" })}: {run().modelCallCount}/
                {run().maxModelCalls || _({ id: "app.lattice.config.unlimited", message: "Unlimited" })}
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-1.5">
          <span class="text-12-medium text-text-base">
            {_({ id: "app.lattice.config.mode", message: "How Lattice runs" })}
          </span>
          <div class="flex gap-2">
            <Button
              variant={mode() === "auto" ? "primary" : "secondary"}
              onClick={() => setMode("auto")}
              disabled={saving()}
            >
              {modeLabel("auto")}
            </Button>
            <Button
              variant={mode() === "collaborative" ? "primary" : "secondary"}
              onClick={() => setMode("collaborative")}
              disabled={saving()}
            >
              {modeLabel("collaborative")}
            </Button>
          </div>
        </div>

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
        />

        <Show when={!!props.sessionID && !existing()}>
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
        </Show>

        <div class="mt-1 flex justify-end gap-2">
          <Show when={canContinue()}>
            <Button variant="secondary" onClick={() => void submit("continue")} disabled={saving()}>
              {_({ id: "app.lattice.config.continueExisting", message: "Continue existing" })}
            </Button>
          </Show>
          <Show when={existing()}>
            <Button variant="secondary" onClick={() => void submit("restart")} disabled={saving()}>
              {_({ id: "app.lattice.config.restart", message: "Restart" })}
            </Button>
          </Show>
          <Show when={!existing()}>
            <Button variant="primary" onClick={() => void submit()} disabled={saving() || loading()}>
              {props.sessionID
                ? _({ id: "app.lattice.config.enable", message: "Enable Lattice" })
                : _({ id: "app.lattice.config.arm", message: "Arm Lattice for this message" })}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
