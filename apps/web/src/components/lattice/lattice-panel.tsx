import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type {
  EventBlueprintLoopCreated,
  EventBlueprintLoopUpdated,
  EventLatticeRunCreated,
  EventLatticeRunUpdated,
  LatticeEvent,
} from "@ericsanchezok/synergy-sdk/client"
import { useConfirm } from "@/components/dialog"
import { useLocale } from "@/context/locale"
import type { SDKContext } from "@/context/sdk"
import { translateDescriptor } from "@/locales/translate"
import {
  controlsForRun,
  currentStepForRun,
  isCurrentLatticeActionTarget,
  isLatticeConflict,
  latticeEventDescriptor,
  LOOP_STATUS_DESCRIPTORS,
  pathwayProgress,
  pauseReasonLabel,
  RUN_STATUS_DESCRIPTORS,
  selectFresherRun,
  STEP_STATUS_DESCRIPTORS,
  toggleExpandedPathwayStep,
  workStateLabel,
  type LatticeLoopView,
  type LatticeRunView,
  type LatticeStepStatus,
} from "./lattice-panel-model"

type LatticeRunEvent = EventLatticeRunCreated | EventLatticeRunUpdated
type LatticeLoopEvent = EventBlueprintLoopCreated | EventBlueprintLoopUpdated
type ExpandedDetails = "blueprints" | "history"

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

function statusDotClass(status: LatticeRunView["status"]): string {
  if (status === "completed") return "bg-icon-success-base"
  if (status === "failed") return "bg-icon-critical-base"
  if (status === "paused") return "bg-icon-warning-base"
  if (status === "cancelled") return "bg-text-weaker"
  return "bg-text-strong"
}

function stepStatusClass(status: LatticeStepStatus): string {
  if (status === "completed") return "text-text-on-success-base"
  if (status === "failed") return "text-text-on-critical-base"
  if (status === "cancelled") return "text-text-weak"
  if (status === "current" || status === "executing") return "text-text-strong"
  return "text-text-weak"
}

export function LatticePanel(props: {
  sdk: SDKContext
  sessionID: string
  onConfigure?: (options?: { confirmRestart?: boolean }) => void
}) {
  const { _ } = useLingui()
  const { fmt, i18n } = useLocale()
  const confirm = useConfirm()
  const [run, setRun] = createSignal<LatticeRunView | null>(null)
  const [loops, setLoops] = createSignal<LatticeLoopView[]>([])
  const [events, setEvents] = createSignal<LatticeEvent[]>([])
  const [expanded, setExpanded] = createSignal<ExpandedDetails>()
  const [expandedPathwayStepID, setExpandedPathwayStepID] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [eventsLoading, setEventsLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string>()
  const [eventsError, setEventsError] = createSignal<string>()
  const [actionError, setActionError] = createSignal<string>()
  const [approvalConflict, setApprovalConflict] = createSignal(false)
  const [approvalQueued, setApprovalQueued] = createSignal(false)
  const [busyAction, setBusyAction] = createSignal<"pause" | "resume" | "cancel" | "approve">()
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
    if (current && next && current.id !== next.id) {
      resetActionState()
      setEvents([])
      setExpanded(undefined)
      setExpandedPathwayStepID(undefined)
    }
    setRun(next)
    if (next?.status !== "active" || next.state !== "awaiting_execution") setApprovalQueued(false)
    return next
  }

  const refreshRun = async (sessionID = props.sessionID, token = generation) => {
    try {
      const result = await props.sdk.client.lattice.session.getRun({ id: sessionID })
      if (token !== generation || sessionID !== props.sessionID) return
      acceptIncomingRun(result.data ?? null)
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

  const refreshEvents = async (target = run(), token = generation) => {
    if (!target) return
    setEventsLoading(true)
    setEventsError(undefined)
    try {
      const result = await props.sdk.client.lattice.run.events({ id: target.id })
      if (token !== generation || target.id !== run()?.id) return
      setEvents((result.data ?? []).toSorted((left, right) => right.time.created - left.time.created))
    } catch (error) {
      if (token !== generation || target.id !== run()?.id) return
      setEventsError(
        errorMessage(
          error,
          _({ id: "app.lattice.panel.historyLoadFailed", message: "Could not load the run history." }),
        ),
      )
    } finally {
      if (token === generation && target.id === run()?.id) setEventsLoading(false)
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    const token = ++generation
    setRun(null)
    setLoops([])
    setEvents([])
    setExpanded(undefined)
    setExpandedPathwayStepID(undefined)
    setLoading(true)
    setLoadError(undefined)
    setEventsError(undefined)
    resetActionState()

    const acceptRun = (event: LatticeRunEvent) => {
      const incoming = event.properties.run
      if (incoming.sessionID !== sessionID || token !== generation) return
      acceptIncomingRun(incoming)
      setLoading(false)
      setLoadError(undefined)
      if (expanded() === "history") void refreshEvents(incoming, token)
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
    return current ? currentStepForRun(current) : undefined
  })
  const progress = createMemo(() => {
    const current = run()
    return current ? pathwayProgress(current) : { completed: 0, failed: 0, pending: 0, total: 0 }
  })
  const progressPercent = createMemo(() =>
    progress().total > 0 ? Math.round((progress().completed / progress().total) * 100) : 0,
  )
  const blueprintSteps = createMemo(
    () =>
      run()?.pathway.filter(
        (step) => step.blueprint || step.blueprintHistory.length > 0 || step.loopHistory.length > 0,
      ) ?? [],
  )
  const loopByID = createMemo(() => new Map(loops().map((loop) => [loop.id, loop])))
  const stepByID = createMemo(() => new Map((run()?.pathway ?? []).map((step) => [step.id, step])))

  const invoke = async (
    action: "pause" | "resume" | "cancel" | "approve",
    request: (input: { id: string }) => Promise<{ data?: unknown }>,
  ) => {
    const current = run()
    if (!current || busyAction()) return
    const target = { generation, sessionID: props.sessionID, runID: current.id }
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

  const toggleDetails = (next: ExpandedDetails) => {
    const value = expanded() === next ? undefined : next
    setExpanded(value)
    if (value === "history" && events().length === 0) void refreshEvents()
  }

  const confirmCancel = () => {
    confirm.show({
      title: { id: "app.lattice.panel.cancelConfirmTitle", message: "Cancel this Lattice run?" },
      description: {
        id: "app.lattice.panel.cancelConfirm",
        message:
          "The run will be marked cancelled and its active BlueprintLoop will stop. It cannot be resumed, but its Pathway and history will remain available.",
      },
      confirmLabel: { id: "app.lattice.panel.confirmCancel", message: "Cancel run" },
      cancelLabel: { id: "app.lattice.panel.keepRun", message: "Keep run" },
      tone: "danger",
      onConfirm: () => invoke("cancel", (input) => props.sdk.client.lattice.run.cancel(input)),
    })
  }

  return (
    <div class="flex size-full min-h-0 min-w-0 flex-col bg-background-base">
      <Show
        when={!loading()}
        fallback={
          <div class="flex size-full items-center justify-center gap-2 text-12-regular text-text-weak" role="status">
            <Spinner class="size-4" />
            {_({ id: "app.lattice.panel.loading", message: "Loading Lattice…" })}
          </div>
        }
      >
        <Show
          when={run()}
          fallback={
            <div class="flex size-full min-h-0 flex-col">
              <div class="flex flex-1 items-center justify-center px-6 py-10">
                <Show
                  when={!loadError()}
                  fallback={
                    <div class="max-w-80 text-center">
                      <div class="text-14-medium text-text-strong">
                        {_({ id: "app.lattice.panel.unavailableTitle", message: "Lattice is unavailable" })}
                      </div>
                      <p class="mt-2 text-12-regular text-text-weak" role="alert">
                        {loadError()}
                      </p>
                      <Button class="mt-4" variant="secondary" onClick={() => void refreshRun()}>
                        {_({ id: "app.lattice.panel.retry", message: "Retry" })}
                      </Button>
                    </div>
                  }
                >
                  <div class="max-w-80 text-center">
                    <div class="mx-auto flex size-9 items-center justify-center rounded-lg bg-surface-inset-base text-icon-base">
                      <Icon name={getSemanticIcon("prompt.lattice")} size="small" />
                    </div>
                    <div class="mt-4 text-15-medium text-text-strong">
                      {_({ id: "app.lattice.panel.emptyTitle", message: "No Lattice run yet" })}
                    </div>
                    <p class="mt-2 text-12-regular leading-5 text-text-weak">
                      {_({
                        id: "app.lattice.panel.emptyDescription",
                        message:
                          "Configure a run to align requirements, plan a Pathway, and execute reviewed Blueprints.",
                      })}
                    </p>
                    <Show when={props.onConfigure}>
                      <Button class="mt-5" variant="primary" onClick={() => props.onConfigure?.()}>
                        {_({ id: "app.lattice.panel.configure", message: "Configure Lattice" })}
                      </Button>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          }
        >
          {(currentRun) => {
            const controls = () => controlsForRun(currentRun())
            return (
              <>
                <div class="min-h-0 flex-1 overflow-y-auto">
                  <div class="mx-auto flex w-full max-w-3xl flex-col px-5 py-5">
                    <header class="border-b border-border-weaker-base pb-5">
                      <div class="flex min-w-0 items-start gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span class={`size-2 shrink-0 rounded-full ${statusDotClass(currentRun().status)}`} />
                            <span class="text-14-medium text-text-strong">
                              {_(RUN_STATUS_DESCRIPTORS[currentRun().status])}
                            </span>
                            <span class="text-12-regular text-text-weak">{workStateLabel(_, currentRun().state)}</span>
                          </div>
                          <div class="mt-1 text-12-regular text-text-weak">{modeLabel(currentRun().mode)}</div>
                        </div>
                        <Show when={props.onConfigure && currentRun().status !== "paused"}>
                          <Button variant="ghost" size="small" onClick={() => props.onConfigure?.()}>
                            {_({ id: "app.lattice.panel.settings", message: "Settings" })}
                          </Button>
                        </Show>
                      </div>

                      <div class="mt-5 grid grid-cols-2 gap-x-6 gap-y-3">
                        <div>
                          <div class="text-11-regular text-text-weak">
                            {_({ id: "app.lattice.panel.steps", message: "Pathway" })}
                          </div>
                          <div class="mt-0.5 text-13-medium text-text-strong">
                            {_({
                              id: "app.lattice.panel.stepsCompleted",
                              message: "{completed} of {total} completed",
                              values: { completed: progress().completed, total: progress().total },
                            })}
                          </div>
                        </div>
                        <div>
                          <div class="text-11-regular text-text-weak">
                            {_({ id: "app.lattice.panel.calls", message: "Model calls" })}
                          </div>
                          <div class="mt-0.5 text-13-medium text-text-strong">
                            {fmt.number(currentRun().modelCallCount)}
                            <span class="font-normal text-text-weak">
                              {" / "}
                              {currentRun().maxModelCalls
                                ? fmt.number(currentRun().maxModelCalls)
                                : _({ id: "app.lattice.panel.unlimited", message: "Unlimited" })}
                            </span>
                          </div>
                        </div>
                      </div>
                      <Show when={progress().total > 0}>
                        <div
                          class="mt-4 h-1 overflow-hidden rounded-full bg-surface-inset-base"
                          role="progressbar"
                          aria-valuemin="0"
                          aria-valuemax="100"
                          aria-valuenow={progressPercent()}
                          aria-label={_({ id: "app.lattice.panel.progressLabel", message: "Pathway progress" })}
                        >
                          <div
                            class={
                              currentRun().status === "completed"
                                ? "h-full rounded-full bg-icon-success-base"
                                : "h-full rounded-full bg-text-strong"
                            }
                            style={{ width: `${progressPercent()}%` }}
                          />
                        </div>
                      </Show>
                    </header>

                    <Show when={currentRun().status === "paused"}>
                      <div class="border-b border-border-weaker-base py-4">
                        <div class="text-12-medium text-text-strong">
                          {pauseReasonLabel(_, currentRun().statusReason)}
                        </div>
                        <Show when={currentRun().statusReason === "model_call_budget_exhausted"}>
                          <p class="mt-1 text-12-regular leading-5 text-text-weak">
                            {_({
                              id: "app.lattice.panel.budgetGuidance",
                              message:
                                "This paused run cannot change its budget. Cancel it to start a new run with a larger limit.",
                            })}
                          </p>
                        </Show>
                      </div>
                    </Show>

                    <section class="border-b border-border-weaker-base py-5">
                      <div class="text-11-medium uppercase tracking-wide text-text-weak">
                        {_({ id: "app.lattice.panel.now", message: "Now" })}
                      </div>
                      <Show
                        when={currentStep()}
                        fallback={
                          <div class="mt-3 text-13-regular text-text-weak">
                            {_({ id: "app.lattice.panel.notStarted", message: "The Pathway has not started yet." })}
                          </div>
                        }
                      >
                        {(step) => (
                          <div class="mt-3 border-l-2 border-border-strong-base pl-4">
                            <div class="text-14-medium leading-5 text-text-strong">{step().title}</div>
                            <p class="mt-1 text-12-regular leading-5 text-text-base">{step().objective}</p>
                            <Show when={step().failureReason}>
                              <p class="mt-2 text-12-regular leading-5 text-text-on-critical-base">
                                {step().failureReason}
                              </p>
                            </Show>
                            <Show when={step().addressesFailedStepIDs?.length}>
                              <p class="mt-2 text-11-regular text-text-weak">
                                {_({
                                  id: "app.lattice.panel.recoveryFor",
                                  message: "Recovery for {steps}",
                                  values: {
                                    steps: fmt.list(
                                      step().addressesFailedStepIDs!.map(
                                        (id) =>
                                          stepByID().get(id)?.title ??
                                          _({ id: "app.lattice.panel.previousStep", message: "previous step" }),
                                      ),
                                    ),
                                  },
                                })}
                              </p>
                            </Show>
                          </div>
                        )}
                      </Show>
                    </section>

                    <Show when={currentRun().pathway.length > 0}>
                      <section class="border-b border-border-weaker-base py-5">
                        <div class="mb-3 text-11-medium uppercase tracking-wide text-text-weak">
                          {_({ id: "app.lattice.panel.pathway", message: "Pathway" })}
                        </div>
                        <ol class="flex min-w-0 flex-col">
                          <For each={currentRun().pathway}>
                            {(step, index) => {
                              const isExpanded = () => expandedPathwayStepID() === step.id
                              const rowContent = () => (
                                <>
                                  <span class="w-5 shrink-0 pt-0.5 text-11-regular tabular-nums text-text-weaker">
                                    {fmt.number(index() + 1)}
                                  </span>
                                  <div class="min-w-0 flex-1">
                                    <div class="flex min-w-0 items-start gap-3">
                                      <span class="min-w-0 flex-1 text-13-medium leading-5 text-text-strong">
                                        {step.title}
                                      </span>
                                      <span class={`shrink-0 text-11-regular ${stepStatusClass(step.status)}`}>
                                        {_(STEP_STATUS_DESCRIPTORS[step.status])}
                                      </span>
                                      <Show when={step.resultSummary}>
                                        <Icon
                                          name={getSemanticIcon(
                                            isExpanded() ? "navigation.collapse" : "navigation.expand",
                                          )}
                                          size="small"
                                        />
                                      </Show>
                                    </div>
                                    <Show when={step.failureReason}>
                                      <p class="mt-1 text-12-regular leading-5 text-text-on-critical-base">
                                        {step.failureReason}
                                      </p>
                                    </Show>
                                    <Show when={step.blueprint || step.loopHistory.length > 0}>
                                      <p class="mt-1 text-11-regular text-text-weak">
                                        <Show when={step.blueprint}>
                                          {(binding) =>
                                            _({
                                              id: "app.lattice.panel.blueprintVersion",
                                              message: "Blueprint v{version}",
                                              values: { version: binding().boundVersion },
                                            })
                                          }
                                        </Show>
                                        <Show when={step.blueprint && step.loopHistory.length > 0}>{" · "}</Show>
                                        <Show when={step.loopHistory.length > 0}>
                                          {_({
                                            id: "app.lattice.panel.loopAttempts",
                                            message:
                                              "{count, plural, one {# execution attempt} other {# execution attempts}}",
                                            values: { count: step.loopHistory.length },
                                          })}
                                        </Show>
                                      </p>
                                    </Show>
                                  </div>
                                </>
                              )

                              return (
                                <li
                                  class="relative min-w-0 border-t border-border-weaker-base first:border-t-0"
                                  classList={{
                                    "border-l-2 border-l-border-strong-base bg-surface-inset-base px-3":
                                      step.id === currentRun().currentStepID,
                                  }}
                                >
                                  <Show
                                    when={step.resultSummary}
                                    fallback={<div class="flex min-w-0 gap-3 py-3">{rowContent()}</div>}
                                  >
                                    <button
                                      type="button"
                                      class="flex w-full min-w-0 gap-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus-base"
                                      aria-expanded={isExpanded()}
                                      onClick={() =>
                                        setExpandedPathwayStepID((current) =>
                                          toggleExpandedPathwayStep(current, step.id),
                                        )
                                      }
                                    >
                                      {rowContent()}
                                    </button>
                                  </Show>
                                  <Show when={isExpanded() ? step.resultSummary : undefined}>
                                    {(summary) => (
                                      <p class="pb-3 pl-8 text-12-regular leading-5 text-text-weak">{summary()}</p>
                                    )}
                                  </Show>
                                </li>
                              )
                            }}
                          </For>
                        </ol>
                      </section>
                    </Show>

                    <section class="border-b border-border-weaker-base">
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 py-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus-base"
                        aria-expanded={expanded() === "blueprints"}
                        onClick={() => toggleDetails("blueprints")}
                      >
                        <span class="min-w-0 flex-1">
                          <span class="block text-13-medium text-text-strong">
                            {_({ id: "app.lattice.panel.blueprintDetails", message: "Blueprint details" })}
                          </span>
                          <span class="mt-0.5 block text-11-regular text-text-weak">
                            {_({
                              id: "app.lattice.panel.blueprintDetailsHint",
                              message: "Objectives, acceptance criteria, assumptions, and execution attempts",
                            })}
                          </span>
                        </span>
                        <Icon
                          name={getSemanticIcon(
                            expanded() === "blueprints" ? "navigation.collapse" : "navigation.expand",
                          )}
                          size="small"
                        />
                      </button>
                      <Show when={expanded() === "blueprints"}>
                        <div class="pb-5">
                          <For
                            each={blueprintSteps()}
                            fallback={
                              <p class="text-12-regular text-text-weak">
                                {_({
                                  id: "app.lattice.panel.noBlueprints",
                                  message: "No Blueprint has been prepared yet.",
                                })}
                              </p>
                            }
                          >
                            {(step) => (
                              <article class="border-t border-border-weaker-base py-4 first:border-t-0 first:pt-0">
                                <div class="text-13-medium text-text-strong">{step.title}</div>
                                <p class="mt-1 text-12-regular leading-5 text-text-base">{step.objective}</p>
                                <Show when={step.blueprint}>
                                  {(binding) => (
                                    <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-11-regular text-text-weak">
                                      <span>
                                        {_({
                                          id: "app.lattice.panel.boundVersion",
                                          message: "Bound version {version}",
                                          values: { version: binding().boundVersion },
                                        })}
                                      </span>
                                      <Show when={binding().reviewedVersion !== undefined}>
                                        <span>
                                          {_({
                                            id: "app.lattice.panel.reviewedVersion",
                                            message: "Reviewed version {version}",
                                            values: { version: binding().reviewedVersion },
                                          })}
                                        </span>
                                      </Show>
                                    </div>
                                  )}
                                </Show>
                                <Show when={step.acceptanceCriteria.length > 0}>
                                  <div class="mt-4">
                                    <div class="text-11-medium text-text-weak">
                                      {_({
                                        id: "app.lattice.panel.acceptanceCriteria",
                                        message: "Acceptance criteria",
                                      })}
                                    </div>
                                    <ul class="mt-2 space-y-1.5">
                                      <For each={step.acceptanceCriteria}>
                                        {(criterion) => (
                                          <li class="flex gap-2 text-12-regular leading-5 text-text-base">
                                            <span aria-hidden="true" class="text-text-weaker">
                                              —
                                            </span>
                                            <span>{criterion}</span>
                                          </li>
                                        )}
                                      </For>
                                    </ul>
                                  </div>
                                </Show>
                                <Show when={step.assumptions.length > 0}>
                                  <div class="mt-4">
                                    <div class="text-11-medium text-text-weak">
                                      {_({ id: "app.lattice.panel.assumptions", message: "Assumptions" })}
                                    </div>
                                    <ul class="mt-2 space-y-1.5">
                                      <For each={step.assumptions}>
                                        {(assumption) => (
                                          <li class="flex gap-2 text-12-regular leading-5 text-text-base">
                                            <span aria-hidden="true" class="text-text-weaker">
                                              —
                                            </span>
                                            <span>{assumption}</span>
                                          </li>
                                        )}
                                      </For>
                                    </ul>
                                  </div>
                                </Show>
                                <Show when={step.loopHistory.length > 0}>
                                  <div class="mt-4">
                                    <div class="text-11-medium text-text-weak">
                                      {_({ id: "app.lattice.panel.executionHistory", message: "Execution attempts" })}
                                    </div>
                                    <div class="mt-2">
                                      <For each={step.loopHistory}>
                                        {(attempt) => {
                                          const loop = () => loopByID().get(attempt.loopID)
                                          const status = () =>
                                            loop()?.status ?? (attempt.status === "created" ? "armed" : attempt.status)
                                          return (
                                            <div class="border-t border-border-weaker-base py-2.5 first:border-t-0">
                                              <div class="flex items-center gap-3">
                                                <span class="min-w-0 flex-1 text-12-regular text-text-base">
                                                  {fmt.dateTime(
                                                    attempt.time.started ??
                                                      attempt.time.completed ??
                                                      attempt.time.created,
                                                  )}
                                                </span>
                                                <span class="text-11-regular text-text-weak">
                                                  {_(LOOP_STATUS_DESCRIPTORS[status()])}
                                                </span>
                                              </div>
                                              <Show when={loop()?.summary ?? attempt.summary}>
                                                <p class="mt-1 text-11-regular leading-4 text-text-weak">
                                                  {loop()?.summary ?? attempt.summary}
                                                </p>
                                              </Show>
                                              <Show when={attempt.error}>
                                                <p class="mt-1 text-11-regular leading-4 text-text-on-critical-base">
                                                  {attempt.error}
                                                </p>
                                              </Show>
                                            </div>
                                          )
                                        }}
                                      </For>
                                    </div>
                                  </div>
                                </Show>
                              </article>
                            )}
                          </For>
                        </div>
                      </Show>
                    </section>

                    <section>
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 py-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus-base"
                        aria-expanded={expanded() === "history"}
                        onClick={() => toggleDetails("history")}
                      >
                        <span class="min-w-0 flex-1">
                          <span class="block text-13-medium text-text-strong">
                            {_({ id: "app.lattice.panel.runHistory", message: "Run history" })}
                          </span>
                          <span class="mt-0.5 block text-11-regular text-text-weak">
                            {_({
                              id: "app.lattice.panel.runHistoryHint",
                              message: "Durable lifecycle and Pathway events",
                            })}
                          </span>
                        </span>
                        <Icon
                          name={getSemanticIcon(expanded() === "history" ? "navigation.collapse" : "navigation.expand")}
                          size="small"
                        />
                      </button>
                      <Show when={expanded() === "history"}>
                        <div class="pb-5">
                          <Show when={eventsLoading()}>
                            <div class="flex items-center gap-2 py-3 text-12-regular text-text-weak" role="status">
                              <Spinner class="size-4" />
                              {_({ id: "app.lattice.panel.historyLoading", message: "Loading run history…" })}
                            </div>
                          </Show>
                          <Show when={eventsError()}>
                            <div class="flex items-center gap-3 py-3" role="alert">
                              <span class="min-w-0 flex-1 text-12-regular text-text-on-critical-base">
                                {eventsError()}
                              </span>
                              <Button variant="ghost" size="small" onClick={() => void refreshEvents()}>
                                {_({ id: "app.lattice.panel.retry", message: "Retry" })}
                              </Button>
                            </div>
                          </Show>
                          <Show when={!eventsLoading() && !eventsError()}>
                            <For
                              each={events()}
                              fallback={
                                <p class="py-3 text-12-regular text-text-weak">
                                  {_({ id: "app.lattice.panel.noHistory", message: "No audit events are available." })}
                                </p>
                              }
                            >
                              {(event) => (
                                <div class="flex gap-3 border-t border-border-weaker-base py-3 first:border-t-0">
                                  <div class="mt-1.5 size-1.5 shrink-0 rounded-full bg-text-weaker" />
                                  <div class="min-w-0 flex-1">
                                    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                      <span class="text-12-medium text-text-strong">
                                        {translateDescriptor(latticeEventDescriptor(event.kind), i18n)}
                                      </span>
                                      <time
                                        class="text-11-regular text-text-weaker"
                                        datetime={new Date(event.time.created).toISOString()}
                                        title={fmt.dateTime(event.time.created)}
                                      >
                                        {fmt.relative(event.time.created)}
                                      </time>
                                    </div>
                                    <Show when={event.stepID ? stepByID().get(event.stepID) : undefined}>
                                      {(step) => (
                                        <div class="mt-0.5 text-11-regular text-text-weak">{step().title}</div>
                                      )}
                                    </Show>
                                    <Show when={event.message}>
                                      <p class="mt-1 text-11-regular leading-4 text-text-weak">{event.message}</p>
                                    </Show>
                                  </div>
                                </div>
                              )}
                            </For>
                          </Show>
                        </div>
                      </Show>
                    </section>

                    <Show when={controls().approve}>
                      <section class="mt-2 border-t border-border-weaker-base py-5">
                        <div class="text-13-medium text-text-strong">
                          {_({ id: "app.lattice.panel.approvalTitle", message: "Blueprint ready for review" })}
                        </div>
                        <p class="mt-1 text-12-regular leading-5 text-text-weak">
                          {_({
                            id: "app.lattice.panel.approvalHint",
                            message:
                              "Review the bound Blueprint above. Continue when this exact version is ready to execute.",
                          })}
                        </p>
                      </section>
                    </Show>

                    <Show when={approvalConflict()}>
                      <div class="mt-3 text-12-regular text-text-on-warning-base" role="alert">
                        {_({
                          id: "app.lattice.panel.approvalConflict",
                          message: "The Blueprint changed. Review the latest version before continuing.",
                        })}
                      </div>
                    </Show>
                    <Show when={actionError()}>
                      <div class="mt-3 text-12-regular text-text-on-critical-base" role="alert">
                        {actionError()}
                      </div>
                    </Show>
                  </div>
                </div>

                <footer class="shrink-0 px-5 pb-4 pt-2">
                  <div class="mx-auto flex w-full max-w-3xl justify-end">
                    <div class="flex max-w-full flex-wrap items-center justify-end gap-1 rounded-lg bg-surface-raised-base p-1 shadow-sm">
                      <Show
                        when={
                          currentRun().status === "completed" ||
                          currentRun().status === "failed" ||
                          currentRun().status === "cancelled"
                        }
                      >
                        <Button variant="primary" onClick={() => props.onConfigure?.({ confirmRestart: true })}>
                          {_({ id: "app.lattice.panel.startNew", message: "Start new run" })}
                        </Button>
                      </Show>
                      <Show when={controls().pause}>
                        <Button
                          variant="ghost"
                          onClick={() => void invoke("pause", (input) => props.sdk.client.lattice.run.pause(input))}
                          disabled={!!busyAction()}
                        >
                          {busyAction() === "pause"
                            ? _({ id: "app.lattice.panel.pausing", message: "Pausing…" })
                            : _({ id: "app.lattice.panel.pause", message: "Pause" })}
                        </Button>
                      </Show>
                      <Show when={controls().resume}>
                        <Button
                          variant="primary"
                          onClick={() => void invoke("resume", (input) => props.sdk.client.lattice.run.resume(input))}
                          disabled={!!busyAction()}
                        >
                          {busyAction() === "resume"
                            ? _({ id: "app.lattice.panel.resuming", message: "Resuming…" })
                            : _({ id: "app.lattice.panel.resume", message: "Resume" })}
                        </Button>
                      </Show>
                      <Show when={controls().approve}>
                        <Button
                          variant="primary"
                          onClick={() => void invoke("approve", (input) => props.sdk.client.lattice.run.approve(input))}
                          disabled={!!busyAction() || approvalQueued()}
                        >
                          {busyAction() === "approve" || approvalQueued()
                            ? _({ id: "app.lattice.panel.continuing", message: "Continuing…" })
                            : _({ id: "app.lattice.panel.continue", message: "Continue" })}
                        </Button>
                      </Show>
                      <Show when={controls().cancel}>
                        <Button
                          variant="ghost"
                          class="text-text-on-critical-base"
                          onClick={confirmCancel}
                          disabled={!!busyAction()}
                        >
                          {_({ id: "app.lattice.panel.cancel", message: "Cancel run" })}
                        </Button>
                      </Show>
                    </div>
                  </div>
                </footer>
              </>
            )
          }}
        </Show>
      </Show>
    </div>
  )
}
