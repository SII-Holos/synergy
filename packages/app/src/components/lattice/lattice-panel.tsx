import { createSignal, createEffect, For, onCleanup, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { LatticeRun, LatticeStep } from "@ericsanchezok/synergy-sdk/client"

export interface LatticePanelSDK {
  event: { on: (type: string, cb: (event: { properties: { run: LatticeRun } }) => void) => () => void }
  client: {
    workflow: {
      session: {
        set: (input: {
          id: string
          workflowSetInput: {
            kind: "none" | "plan" | "lightloop" | "lattice"
            mode?: "auto" | "collaborative"
            maxModelCalls?: number
            action?: "continue" | "restart"
          }
        }) => Promise<{ data?: unknown }>
      }
    }
    lattice: {
      session: {
        getRun: (input: { id: string }) => Promise<{ data?: LatticeRun | null }>
      }
      run: {
        continue: (input: {
          id: string
          latticeRunContinueInput?: { userPrompt?: string }
        }) => Promise<{ data?: LatticeRun | null }>
        cancel: (input: { id: string }) => Promise<{ data?: LatticeRun | null }>
      }
    }
  }
}

const ACTIVE_STATUSES = new Set(["active", "paused"])

function stepBadgeClass(status: LatticeStep["status"]): string {
  switch (status) {
    case "completed":
      return "text-text-on-success-base"
    case "failed":
      return "text-text-on-critical-base"
    case "running":
      return "text-text-interactive-base"
    case "cancelled":
    case "blocked":
      return "text-text-weak"
    default:
      return "text-text-base"
  }
}

export function LatticePanel(props: { sdk: LatticePanelSDK; sessionID: string }) {
  const [run, setRun] = createSignal<LatticeRun | null>(null)
  const [reviewPrompt, setReviewPrompt] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    void props.sdk.client.lattice.session
      .getRun({ id: sessionID })
      .then((r) => setRun(r.data ?? null))
      .catch(() => setRun(null))
    const unsub = props.sdk.event.on("lattice.run.updated", (event) => {
      if (event.properties.run.sessionID === sessionID) setRun(event.properties.run)
    })
    onCleanup(unsub)
  })

  const visible = () => {
    const r = run()
    return !!r && ACTIVE_STATUSES.has(r.status)
  }

  const steps = (r: LatticeRun) => r.pathway ?? []
  const currentTitle = (r: LatticeRun) => steps(r).find((s) => s.id === r.currentStepID)?.title ?? "—"

  const isReview = () => {
    const r = run()
    return !!r && r.status === "active" && r.mode === "collaborative" && r.phase === "blueprint_review"
  }

  const isPaused = () => run()?.status === "paused"

  const doContinue = async () => {
    const r = run()
    if (!r) return
    setBusy(true)
    try {
      await props.sdk.client.lattice.run.continue({
        id: r.id,
        latticeRunContinueInput: reviewPrompt().trim() ? { userPrompt: reviewPrompt().trim() } : undefined,
      })
      setReviewPrompt("")
    } catch (err) {
      showToast({
        type: "error",
        title: "Continue failed",
        description: err instanceof Error ? err.message : "Unknown",
      })
    } finally {
      setBusy(false)
    }
  }

  const doResume = async () => {
    const r = run()
    if (!r) return
    setBusy(true)
    try {
      await props.sdk.client.workflow.session.set({
        id: props.sessionID,
        workflowSetInput: {
          kind: "lattice",
          mode: r.mode,
          maxModelCalls: r.maxModelCalls,
          action: "continue",
        },
      })
    } catch (err) {
      showToast({ type: "error", title: "Resume failed", description: err instanceof Error ? err.message : "Unknown" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={visible() && run()}>
      {(r) => (
        <div class="flex flex-col gap-2 rounded-lg border border-border-base/60 bg-surface-weak/40 px-3 py-2">
          <div class="flex items-center gap-2 text-11-medium">
            <span class="rounded bg-surface-interactive-selected-weak/70 px-1.5 py-0.5 text-text-interactive-base">
              Lattice · {r().mode}
            </span>
            <span class="text-text-weak">{r().phase}</span>
            <Show when={r().status === "paused"}>
              <span class="text-text-on-warning-base">paused{r().statusReason ? ` (${r().statusReason})` : ""}</span>
            </Show>
            <span class="ml-auto text-text-weak">
              {steps(r()).filter((s) => s.status === "completed").length}/{steps(r()).length} · calls{" "}
              {r().modelCallCount}/{r().maxModelCalls || "∞"}
            </span>
          </div>

          <div class="text-11-regular text-text-weak">
            Current: <span class="text-text-base">{currentTitle(r())}</span>
          </div>

          <Show when={steps(r()).length > 0}>
            <ul class="flex flex-col gap-0.5">
              <For each={steps(r())}>
                {(step, index) => (
                  <li class="flex items-center gap-2 text-11-regular">
                    <span class="w-4 text-right text-text-weak">{index() + 1}.</span>
                    <span class={stepBadgeClass(step.status)}>[{step.status}]</span>
                    <span class={step.id === r().currentStepID ? "text-text-strong" : "text-text-base"}>
                      {step.title}
                    </span>
                    <Show when={step.addressesFailedStepIDs && step.addressesFailedStepIDs.length > 0}>
                      <span class="text-text-weak">↺ recovery</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={isReview()}>
            <div class="flex flex-col gap-1.5 rounded-md border border-border-interactive-base/40 bg-surface-interactive-selected-weak/40 p-2">
              <div class="text-11-medium text-text-strong">Blueprint ready for review</div>
              <div class="text-10-regular text-text-weak">
                Discuss or edit the Blueprint in chat. Messages are treated as discussion — click Continue to execute.
              </div>
              <TextField
                label="Optional instruction for execution"
                hideLabel
                type="text"
                placeholder="Optional instruction merged into execution…"
                value={reviewPrompt()}
                onChange={setReviewPrompt}
              />
              <div class="flex justify-end">
                <Button variant="primary" size="small" onClick={() => void doContinue()} disabled={busy()}>
                  Continue
                </Button>
              </div>
            </div>
          </Show>

          <Show when={isPaused()}>
            <div class="flex justify-end">
              <Button variant="secondary" size="small" onClick={() => void doResume()} disabled={busy()}>
                Resume Lattice
              </Button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
