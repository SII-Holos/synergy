import { createSignal, onMount, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { LatticeRun } from "@ericsanchezok/synergy-sdk/client"

type LatticeMode = "auto" | "collaborative"

export interface LatticeSDKLike {
  client: {
    lattice: {
      session: {
        get: (input: { id: string }) => Promise<{ data?: LatticeRun | null }>
        mode: (input: {
          id: string
          latticeModeInput: {
            enabled: boolean
            mode?: LatticeMode
            max_model_calls?: number
            goal?: string
            action?: "continue" | "restart"
          }
        }) => Promise<{ data?: LatticeRun | null }>
      }
    }
  }
}

const RESUMABLE = new Set(["paused"])

function progressLabel(run: LatticeRun): string {
  const pathway = run.pathway ?? []
  const total = pathway.length
  const done = pathway.filter((s) => s.status === "completed").length
  return `${done}/${total} steps`
}

function statusLine(run: LatticeRun): string {
  const reason = run.statusReason ? ` (${run.statusReason})` : ""
  return `${run.status}${reason} · ${run.phase} · ${run.mode}`
}

export function LatticeConfigDialog(props: { sdk: LatticeSDKLike; sessionID: string }) {
  const dialog = useDialog()
  const [existing, setExisting] = createSignal<LatticeRun | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [mode, setMode] = createSignal<LatticeMode>("auto")
  const [budget, setBudget] = createSignal("0")
  const [goal, setGoal] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  onMount(async () => {
    try {
      const result = await props.sdk.client.lattice.session.get({ id: props.sessionID })
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
      await props.sdk.client.lattice.session.mode({
        id: props.sessionID,
        latticeModeInput: {
          enabled: true,
          mode: mode(),
          max_model_calls: parsedBudget,
          goal: goal().trim() || undefined,
          action,
        },
      })
      showToast({
        type: "info",
        title: "Lattice enabled",
        description: `${mode()} · budget ${parsedBudget || "unlimited"}`,
      })
      dialog.close()
    } catch (err) {
      showToast({
        type: "error",
        title: "Failed to enable Lattice",
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Lattice mode" size="form">
      <div data-slot="dialog-form" class="flex flex-col gap-4">
        <p class="text-12-regular text-text-weak">
          Lattice runs your goal as a recursive Blueprint: it plans an ordered Pathway and executes each step as a
          BlueprintLoop. Auto keeps advancing on its own; Collaborative pauses after each Blueprint for your review.
        </p>

        <Show when={!loading() && existing()}>
          {(run) => (
            <div class="rounded-lg border border-border-base/60 bg-surface-weak/40 p-3">
              <div class="text-11-medium text-text-weak uppercase tracking-wide">Previous run</div>
              <div class="mt-1 text-12-medium text-text-strong">{statusLine(run())}</div>
              <div class="mt-1 text-11-regular text-text-weak">
                {progressLabel(run())}
                <Show when={run().currentStepID}>
                  {" · current: "}
                  {(run().pathway ?? []).find((s) => s.id === run().currentStepID)?.title ?? run().currentStepID}
                </Show>
              </div>
              <div class="mt-1 text-11-regular text-text-weak">
                model calls: {run().modelCallCount}/{run().maxModelCalls || "unlimited"}
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-1.5">
          <span class="text-12-medium text-text-base">Mode</span>
          <div class="flex gap-2">
            <Button
              variant={mode() === "auto" ? "primary" : "secondary"}
              onClick={() => setMode("auto")}
              disabled={saving()}
            >
              Auto
            </Button>
            <Button
              variant={mode() === "collaborative" ? "primary" : "secondary"}
              onClick={() => setMode("collaborative")}
              disabled={saving()}
            >
              Collaborative
            </Button>
          </div>
        </div>

        <TextField label="Model-call budget (0 = unlimited)" type="number" value={budget()} onChange={setBudget} />

        <Show when={!existing()}>
          <TextField
            label="Goal (optional)"
            type="text"
            placeholder="What should this Lattice run accomplish?"
            value={goal()}
            onChange={setGoal}
          />
        </Show>

        <div class="mt-1 flex justify-end gap-2">
          <Show when={canContinue()}>
            <Button variant="secondary" onClick={() => void submit("continue")} disabled={saving()}>
              Continue existing
            </Button>
          </Show>
          <Show when={existing()}>
            <Button variant="secondary" onClick={() => void submit("restart")} disabled={saving()}>
              Restart
            </Button>
          </Show>
          <Show when={!existing()}>
            <Button variant="primary" onClick={() => void submit()} disabled={saving() || loading()}>
              Enable Lattice
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
