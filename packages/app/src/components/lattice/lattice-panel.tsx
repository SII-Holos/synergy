import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type {
  EventBlueprintLoopCreated,
  EventBlueprintLoopUpdated,
  EventLatticeRunCreated,
  EventLatticeRunUpdated,
} from "@ericsanchezok/synergy-sdk/client"
import type { SDKContext } from "@/context/sdk"
import {
  controlsForRun,
  isCurrentLatticeActionTarget,
  isLatticeConflict,
  LOOP_STATUS_DESCRIPTORS,
  pauseReasonLabel,
  referencedLoopIDs,
  RUN_STATUS_DESCRIPTORS,
  runWorkState,
  selectFresherRun,
  shouldDismissCancelConfirmation,
  STEP_STATUS_DESCRIPTORS,
  workStateLabel,
  type LatticeLoopView,
  type LatticeRunView,
  type LatticeStepStatus,
} from "./lattice-panel-model"

type LatticeRunEvent = EventLatticeRunCreated | EventLatticeRunUpdated
type LatticeLoopEvent = EventBlueprintLoopCreated | EventBlueprintLoopUpdated

function stepBadgeClass(status: LatticeStepStatus): string {
  switch (status) {
    case "completed":
      return "text-text-on-success-base"
    case "failed":
      return "text-text-on-critical-base"
    case "current":
    case "executing":
      return "text-text-interactive-base"
    case "cancelled":
      return "text-text-weak"
    default:
      return "text-text-base"
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function mergeLoops(current: LatticeLoopView[], incoming: LatticeLoopView[]): LatticeLoopView[] {
  const byID = new Map(current.map((loop) => [loop.id, loop]))
  for (const loop of incoming) {
    const existing = byID.get(loop.id)
    if (!existing || loop.time.updated >= existing.time.updated) byID.set(loop.id, loop)
  }
  return [...byID.values()].sort((a, b) => b.time.updated - a.time.updated)
}

export function LatticePanel(props: { sdk: SDKContext; sessionID: string }) {
  const { _ } = useLingui()
  const [run, setRun] = createSignal<LatticeRunView | null>(null)
  const [loops, setLoops] = createSignal<LatticeLoopView[]>([])
  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal<string>()
  const [actionError, setActionError] = createSignal<string>()
  const [approvalConflict, setApprovalConflict] = createSignal(false)
  const [approvalQueued, setApprovalQueued] = createSignal(false)
  const [busyAction, setBusyAction] = createSignal<"pause" | "resume" | "cancel" | "approve">()
  const [confirmCancel, setConfirmCancel] = createSignal(false)
  let cancelButton: HTMLButtonElement | undefined
  let keepRunButton: HTMLButtonElement | undefined
  let generation = 0

  const modeLabel = (mode: LatticeRunView["mode"]) =>
    mode === "auto"
      ? _({ id: "app.lattice.config.mode.auto", message: "Advance autonomously" })
      : _({ id: "app.lattice.config.mode.collaborative", message: "Work with you" })

  const resetActionState = () => {
    setActionError(undefined)
    setApprovalConflict(false)
    setApprovalQueued(false)
    setBusyAction(undefined)
  }

  const acceptIncomingRun = (incoming: LatticeRunView | null) => {
    const current = run()
    const next = selectFresherRun(current, incoming)
    if (current && next && current.id !== next.id) resetActionState()
    setRun(next)
    if (next?.status !== "active" || next.state !== "awaiting_execution") {
      setApprovalQueued(false)
    }
    return next
  }

  const refreshRun = async (sessionID = props.sessionID, token = generation) => {
    try {
      const result = await props.sdk.client.lattice.session.getRun({ id: sessionID })
      if (token !== generation || sessionID !== props.sessionID) return
      const incoming = result.data ?? null
      acceptIncomingRun(incoming)
      setLoadError(undefined)
    } catch (error) {
      if (token !== generation || sessionID !== props.sessionID) return
      setLoadError(
        errorMessage(error, _({ id: "app.lattice.panel.loadFailed", message: "Could not load this Lattice run." })),
      )
    } finally {
      if (token === generation && sessionID === props.sessionID) setLoading(false)
    }
  }

  const refreshLoops = async (sessionID = props.sessionID, token = generation) => {
    try {
      const result = await props.sdk.client.blueprint.loop.list()
      if (token !== generation || sessionID !== props.sessionID) return
      const scoped = (result.data ?? []).filter((loop) => loop.source === "lattice" && loop.sessionID === sessionID)
      setLoops((current) => mergeLoops(current, scoped))
    } catch {
      if (token === generation && sessionID === props.sessionID) setLoops([])
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    const token = ++generation
    setRun(null)
    setLoops([])
    setLoading(true)
    setLoadError(undefined)
    resetActionState()
    setConfirmCancel(false)

    const acceptRun = (event: LatticeRunEvent) => {
      const incoming = event.properties.run
      if (incoming.sessionID !== sessionID || token !== generation) return
      acceptIncomingRun(incoming)
      setLoading(false)
      setLoadError(undefined)
    }
    const acceptLoop = (event: LatticeLoopEvent) => {
      const incoming = event.properties.loop
      if (incoming.sessionID !== sessionID || incoming.source !== "lattice" || token !== generation) return
      setLoops((current) => mergeLoops(current, [incoming]))
    }

    const unsubscribers = [
      props.sdk.event.on("lattice.run.created", acceptRun),
      props.sdk.event.on("lattice.run.updated", acceptRun),
      props.sdk.event.on("blueprint_loop.created", acceptLoop),
      props.sdk.event.on("blueprint_loop.updated", acceptLoop),
    ]
    void refreshRun(sessionID, token)
    void refreshLoops(sessionID, token)
    onCleanup(() => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    })
  })

  const currentStep = createMemo(() => {
    const current = run()
    if (!current) return undefined
    return (
      current.pathway.find((step) => step.id === current.currentStepID) ??
      current.pathway.find((step) => step.status === "current" || step.status === "executing")
    )
  })
  const completedCount = createMemo(() => run()?.pathway.filter((step) => step.status === "completed").length ?? 0)
  const remainingCount = createMemo(
    () => run()?.pathway.filter((step) => step.status === "pending" || step.status === "current").length ?? 0,
  )
  const failedCount = createMemo(
    () => run()?.pathway.filter((step) => step.status === "failed" || step.status === "cancelled").length ?? 0,
  )
  const runLoops = createMemo(() => {
    const current = run()
    if (!current) return []
    const ids = referencedLoopIDs(current)
    const fetched = new Map(
      loops()
        .filter((loop) => ids.has(loop.id))
        .map((loop) => [loop.id, loop]),
    )
    return current.pathway.flatMap((step) =>
      step.loopHistory.map((attempt): LatticeLoopView => {
        const live = fetched.get(attempt.loopID)
        if (live) return live
        return {
          id: attempt.loopID,
          title: step.title,
          sessionID: current.sessionID,
          source: "lattice",
          status: attempt.status === "created" ? "armed" : attempt.status,
          summary: attempt.summary,
          time: {
            created: attempt.time.created,
            updated: attempt.time.completed ?? attempt.time.started ?? attempt.time.created,
            completed: attempt.time.completed,
          },
        }
      }),
    )
  })
  const blueprints = createMemo(() => {
    const current = run()
    if (!current) return []
    return current.pathway.flatMap((step) => [
      ...(step.blueprint
        ? [
            {
              title: `${step.title} v${step.blueprint.boundVersion}`,
              stepTitle: step.title,
              current: true,
            },
          ]
        : []),
      ...step.blueprintHistory.map((binding) => ({
        title: `${step.title} v${binding.boundVersion}`,
        stepTitle: step.title,
        current: false,
      })),
    ])
  })

  createEffect(() => {
    if (!confirmCancel()) return
    queueMicrotask(() => keepRunButton?.focus())
  })

  const closeCancelConfirmation = () => {
    setConfirmCancel(false)
    queueMicrotask(() => cancelButton?.focus())
  }

  const invoke = async (
    action: "pause" | "resume" | "cancel" | "approve",
    request: (input: { id: string }) => Promise<{ data?: unknown }>,
  ) => {
    const current = run()
    if (!current || busyAction()) return
    const target = {
      generation,
      sessionID: props.sessionID,
      runID: current.id,
    }
    const isCurrentTarget = () =>
      isCurrentLatticeActionTarget(target, {
        generation,
        sessionID: props.sessionID,
        runID: run()?.id,
      })
    setBusyAction(action)
    setActionError(undefined)
    setApprovalConflict(false)
    try {
      await request({ id: current.id })
      if (!isCurrentTarget()) return
      if (action === "approve") setApprovalQueued(true)
      await refreshRun(target.sessionID, target.generation)
      if (!isCurrentTarget()) return
      if (action === "cancel") setConfirmCancel(false)
    } catch (error) {
      if (!isCurrentTarget()) return
      if (action === "approve" && isLatticeConflict(error)) {
        setApprovalQueued(false)
        setApprovalConflict(true)
        await refreshRun(target.sessionID, target.generation)
      } else {
        const message = errorMessage(
          error,
          _({ id: "app.lattice.panel.actionFailed", message: "The Lattice action failed." }),
        )
        setActionError(message)
        showToast({
          type: "error",
          title: _({ id: "app.lattice.panel.actionFailedTitle", message: "Lattice action failed" }),
          description: message,
        })
      }
    } finally {
      if (isCurrentTarget()) setBusyAction(undefined)
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={
        <div
          class="w-full min-w-0 rounded-lg border border-border-base/60 bg-surface-weak/40 px-3 py-2 text-11-regular text-text-weak"
          role="status"
          aria-live="polite"
        >
          {_({ id: "app.lattice.panel.loading", message: "Loading Lattice…" })}
        </div>
      }
    >
      <Show
        when={run()}
        fallback={
          <Show when={loadError()}>
            <div
              class="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border-critical-base/50 bg-surface-critical-weak/30 px-3 py-2"
              role="alert"
            >
              <span class="min-w-0 flex-1 text-11-regular text-text-on-critical-base">{loadError()}</span>
              <Button variant="secondary" size="small" onClick={() => void refreshRun()}>
                {_({ id: "app.lattice.panel.retry", message: "Retry" })}
              </Button>
            </div>
          </Show>
        }
      >
        {(currentRun) => {
          const controls = () => controlsForRun(currentRun())
          const workState = () => runWorkState(currentRun())
          return (
            <section
              class="flex w-full min-w-0 flex-col gap-3 rounded-lg border border-border-base/60 bg-surface-weak/40 px-3 py-2.5"
              aria-label={_({ id: "app.lattice.panel.label", message: "Lattice run" })}
            >
              <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11-medium">
                <span class="rounded bg-surface-interactive-selected-weak/70 px-1.5 py-0.5 text-text-interactive-base">
                  {_(RUN_STATUS_DESCRIPTORS[currentRun().status])}
                </span>
                <Show when={workState()}>
                  {(state) => <span class="text-text-strong">{workStateLabel(_, state())}</span>}
                </Show>
                <span class="text-text-weak">{modeLabel(currentRun().mode)}</span>
                <span class="ml-auto text-text-weak">
                  {_({
                    id: "app.lattice.panel.stepProgress",
                    message: "{completed} completed · {remaining} remaining · {failed} failed",
                    values: {
                      completed: completedCount(),
                      remaining: remainingCount(),
                      failed: failedCount(),
                    },
                  })}
                </span>
              </div>

              <Show when={currentRun().status === "paused"}>
                <div class="rounded-md border border-border-warning-base/40 bg-surface-warning-weak/30 px-2.5 py-2 text-11-regular text-text-on-warning-base">
                  {pauseReasonLabel(_, currentRun().statusReason)}
                </div>
              </Show>

              <div class="grid min-w-0 grid-cols-1 gap-2 text-11-regular sm:grid-cols-2">
                <div class="min-w-0">
                  <div class="text-10-medium uppercase tracking-wide text-text-weak">
                    {_({ id: "app.lattice.panel.currentStep", message: "Current step" })}
                  </div>
                  <div class="mt-0.5 truncate text-text-base">
                    {currentStep()?.title ?? _({ id: "app.lattice.panel.notStarted", message: "Not started" })}
                  </div>
                </div>
                <div class="min-w-0 sm:text-right">
                  <div class="text-10-medium uppercase tracking-wide text-text-weak">
                    {_({ id: "app.lattice.panel.calls", message: "Model calls" })}
                  </div>
                  <div class="mt-0.5 text-text-base">
                    {currentRun().modelCallCount}/
                    {currentRun().maxModelCalls || _({ id: "app.lattice.panel.unlimited", message: "Unlimited" })}
                  </div>
                </div>
              </div>

              <Show when={currentRun().pathway.length > 0}>
                <div class="min-w-0">
                  <div class="mb-1 text-10-medium uppercase tracking-wide text-text-weak">
                    {_({ id: "app.lattice.panel.pathway", message: "Pathway" })}
                  </div>
                  <ol class="flex min-w-0 flex-col gap-1">
                    <For each={currentRun().pathway}>
                      {(step) => (
                        <li class="flex min-w-0 items-start gap-2 text-11-regular">
                          <span class={`shrink-0 ${stepBadgeClass(step.status)}`}>
                            {_(STEP_STATUS_DESCRIPTORS[step.status])}
                          </span>
                          <span class="min-w-0 flex-1 text-text-base">
                            <span class={step.id === currentRun().currentStepID ? "font-medium text-text-strong" : ""}>
                              {step.title}
                            </span>
                            <Show when={step.resultSummary}>
                              <span class="block text-text-weak">{step.resultSummary}</span>
                            </Show>
                            <Show when={step.failureReason}>
                              <span class="block text-text-on-critical-base">{step.failureReason}</span>
                            </Show>
                          </span>
                        </li>
                      )}
                    </For>
                  </ol>
                </div>
              </Show>

              <Show when={blueprints().length > 0}>
                <div class="min-w-0">
                  <div class="mb-1 text-10-medium uppercase tracking-wide text-text-weak">
                    {_({ id: "app.lattice.panel.blueprints", message: "Blueprints" })}
                  </div>
                  <ul class="flex min-w-0 flex-col gap-1">
                    <For each={blueprints()}>
                      {(blueprint) => (
                        <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-11-regular">
                          <span class="truncate text-text-base">{blueprint.title}</span>
                          <span class="text-10-regular text-text-weak">
                            {blueprint.current
                              ? _({ id: "app.lattice.panel.blueprintCurrent", message: "Current" })
                              : _({ id: "app.lattice.panel.blueprintHistory", message: "History" })}
                            {` · ${blueprint.stepTitle}`}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>

              <Show when={runLoops().length > 0}>
                <div class="min-w-0">
                  <div class="mb-1 text-10-medium uppercase tracking-wide text-text-weak">
                    {_({ id: "app.lattice.panel.blueprintLoops", message: "BlueprintLoops" })}
                  </div>
                  <ul class="flex min-w-0 flex-col gap-1">
                    <For each={runLoops()}>
                      {(loop) => (
                        <li class="flex min-w-0 items-start gap-2 text-11-regular">
                          <span class="min-w-0 flex-1 text-text-base">
                            <span class="block truncate">{loop.title}</span>
                            <Show when={loop.summary}>
                              <span class="block text-10-regular text-text-weak">{loop.summary}</span>
                            </Show>
                          </span>
                          <span class="shrink-0 text-text-weak">{_(LOOP_STATUS_DESCRIPTORS[loop.status])}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>

              <Show when={controls().approve}>
                <div class="rounded-md border border-border-interactive-base/40 bg-surface-interactive-selected-weak/40 p-2.5">
                  <div class="text-11-medium text-text-strong">
                    {_({ id: "app.lattice.panel.approvalTitle", message: "Blueprint ready for your approval" })}
                  </div>
                  <p class="mt-1 text-10-regular text-text-weak">
                    {_({
                      id: "app.lattice.panel.approvalHint",
                      message:
                        "Ask for changes in chat or edit the Blueprint. Approve only when this version is ready to execute.",
                    })}
                  </p>
                  <div class="mt-2 flex justify-end">
                    <Button
                      variant="primary"
                      size="small"
                      onClick={() => void invoke("approve", (input) => props.sdk.client.lattice.run.approve(input))}
                      disabled={!!busyAction() || approvalQueued()}
                    >
                      {busyAction() === "approve" || approvalQueued()
                        ? _({ id: "app.lattice.panel.approving", message: "Approving…" })
                        : _({ id: "app.lattice.panel.approve", message: "Approve" })}
                    </Button>
                  </div>
                </div>
              </Show>

              <Show when={approvalConflict()}>
                <div class="text-11-regular text-text-on-warning-base" role="alert">
                  {_({
                    id: "app.lattice.panel.approvalConflict",
                    message: "Blueprint changed, review required.",
                  })}
                </div>
              </Show>
              <Show when={actionError()}>
                <div class="text-11-regular text-text-on-critical-base" role="alert">
                  {actionError()}
                </div>
              </Show>

              <Show when={controls().pause || controls().resume || controls().cancel}>
                <div class="flex min-w-0 flex-wrap justify-end gap-2">
                  <Show when={controls().pause}>
                    <Button
                      ref={(element: HTMLButtonElement) => {
                        cancelButton = element
                      }}
                      variant="secondary"
                      size="small"
                      onClick={() => void invoke("pause", (input) => props.sdk.client.lattice.run.pause(input))}
                      disabled={!!busyAction()}
                    >
                      {_({ id: "app.lattice.panel.pause", message: "Pause" })}
                    </Button>
                  </Show>
                  <Show when={controls().resume}>
                    <Button
                      variant="primary"
                      size="small"
                      onClick={() => void invoke("resume", (input) => props.sdk.client.lattice.run.resume(input))}
                      disabled={!!busyAction()}
                    >
                      {_({ id: "app.lattice.panel.resume", message: "Resume" })}
                    </Button>
                  </Show>
                  <Show when={controls().cancel && !confirmCancel()}>
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => setConfirmCancel(true)}
                      disabled={!!busyAction()}
                    >
                      {_({ id: "app.lattice.panel.cancel", message: "Cancel run" })}
                    </Button>
                  </Show>
                </div>
              </Show>

              <Show when={confirmCancel()}>
                <div
                  class="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border-critical-base/40 bg-surface-critical-weak/30 p-2.5"
                  role="alertdialog"
                  aria-label={_({ id: "app.lattice.panel.cancelConfirmTitle", message: "Cancel this Lattice run?" })}
                  onKeyDown={(event) => {
                    if (shouldDismissCancelConfirmation(event.key)) closeCancelConfirmation()
                  }}
                >
                  <p class="min-w-0 flex-1 text-11-regular text-text-base">
                    {_({
                      id: "app.lattice.panel.cancelConfirm",
                      message: "Cancellation is permanent. Pathway and execution history remain available for review.",
                    })}
                  </p>
                  <Button
                    ref={(element: HTMLButtonElement) => {
                      keepRunButton = element
                    }}
                    variant="secondary"
                    size="small"
                    onClick={closeCancelConfirmation}
                    disabled={!!busyAction()}
                  >
                    {_({ id: "app.lattice.panel.keepRun", message: "Keep run" })}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    onClick={() => void invoke("cancel", (input) => props.sdk.client.lattice.run.cancel(input))}
                    disabled={!!busyAction()}
                  >
                    {_({ id: "app.lattice.panel.confirmCancel", message: "Cancel permanently" })}
                  </Button>
                </div>
              </Show>
            </section>
          )
        }}
      </Show>
    </Show>
  )
}
