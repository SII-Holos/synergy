import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { createMemo, createSignal, For, Show, onCleanup, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import { Popover, restorePopoverFocus } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useExecution } from "@/context/execution"
import { useSDK } from "@/context/sdk"
import { E } from "./i18n"
import { CompactExecutionOverview, TaskStatusIcon } from "./compact-overview"
import {
  compactTasks,
  compactTokenText,
  compactTaskStatus,
  cancellableTask,
  type TaskDetailsTask,
} from "./task-details-model"
import "./execution.css"
import "./task-details.css"

export function TaskDetailsPopover(props: {
  context?: (active: () => boolean) => JSX.Element
  agenda?: (active: () => boolean, close: () => void) => JSX.Element
  inbox?: (active: () => boolean, history: () => boolean) => JSX.Element
  inboxCount?: number
}) {
  const { _, i18n } = useLingui()
  const execution = useExecution()
  const sdk = useSDK()
  const params = useParams()
  const [open, setOpen] = createSignal(false)
  const [history, setHistory] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [pending, setPending] = createSignal<Set<string>>(new Set())
  const now = execution.advance
  let disposed = false
  let more: HTMLButtonElement | undefined
  let back: HTMLButtonElement | undefined
  let triggerElement: HTMLButtonElement | undefined
  const visible = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect()
    return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility === "visible"
  }
  const toggle = (value: boolean) => {
    const retained = value && back?.isConnected
    if (value) setHistory(false)
    setOpen(value)
    if (!value) setMenuOpen(false)
    if (retained)
      queueMicrotask(() => {
        if (open()) more?.focus({ preventScroll: true })
      })
    if (value && execution.available()) void execution.refresh()
  }
  onCleanup(() => {
    disposed = true
  })
  const Context = () => props.context?.(() => open() && !history())
  const Agenda = () =>
    props.agenda?.(
      () => open() && !history(),
      () => toggle(false),
    )
  const Inbox = () => props.inbox?.(() => open(), history)
  const tasks = createMemo(() => compactTasks(execution.state.summary?.tasks ?? []))
  const showFull = (nodeID?: string) => {
    toggle(false)
    void execution.open(undefined, nodeID)
  }
  const cancel = async (task: TaskDetailsTask) => {
    if (!cancellableTask(task) || !task.cortex || pending().has(task.sessionID)) return
    setPending((value) => new Set([...value, task.sessionID]))
    try {
      await sdk.client.cortex.cancel({ taskID: task.cortex.taskID }, { throwOnError: true })
      if (!disposed) await execution.refresh()
    } catch {
      if (!disposed) showToast({ type: "error", title: _(E.cancelFailed) })
    } finally {
      if (!disposed) setPending((value) => new Set([...value].filter((id) => id !== task.sessionID)))
    }
  }
  const taskHelp = (task: TaskDetailsTask) =>
    [
      task.title,
      _(E[compactTaskStatus(task)]),
      task.cortex?.agent,
      compactTokenText(task.tokens, task.runs.length, i18n().locale),
    ]
      .filter(Boolean)
      .join(" · ")
  return (
    <Show when={params.id}>
      <Popover
        title={history() ? _(E.inboxHistory) : _(E.title)}
        class="execution-popover"
        placement="bottom-end"
        gutter={8}
        open={open()}
        onOpenChange={toggle}
        contentProps={{
          onCloseAutoFocus: (event: Event) => {
            if (!triggerElement || visible(triggerElement)) return
            const replacement = Array.from(
              triggerElement.closest(".stb-root")?.querySelectorAll<HTMLButtonElement>(".execution-trigger") ?? [],
            ).find(visible)
            if (!replacement) return
            event.preventDefault()
            void restorePopoverFocus(replacement, event.target instanceof HTMLElement ? event.target : undefined)
          },
        }}
        triggerAs={(trigger) => (
          <button
            {...trigger}
            ref={triggerElement}
            type="button"
            class="stb-icon-btn execution-trigger"
            aria-label={_(E.title)}
            aria-expanded={open()}
            data-state={execution.state.summary?.status}
          >
            <Icon name={getSemanticIcon("session.taskDetails")} size="small" />
            <Show when={props.inboxCount}>
              <span class="execution-trigger-count">{props.inboxCount}</span>
            </Show>
          </button>
        )}
      >
        <Show when={!history()}>
          <div class="execution-compact-identity">
            <Context />
            <Popover
              title={_(E.more)}
              variant="menu"
              open={menuOpen()}
              onOpenChange={setMenuOpen}
              placement="bottom-end"
              class="execution-options"
              triggerAs={(trigger) => (
                <button
                  {...trigger}
                  ref={more}
                  type="button"
                  class="execution-icon-action execution-identity-action"
                  data-open={menuOpen()}
                  aria-label={_(E.more)}
                >
                  <Icon name={getSemanticIcon("action.more")} size="small" />
                </button>
              )}
            >
              <Show when={execution.available()}>
                <button type="button" class="execution-menu-action" onClick={() => showFull()}>
                  <Icon name={getSemanticIcon("action.open")} size="small" />
                  {_(E.full)}
                </button>
              </Show>
              <Show when={props.inbox}>
                <button
                  type="button"
                  class="execution-menu-action"
                  onClick={() => {
                    setMenuOpen(false)
                    setHistory(true)
                    queueMicrotask(() => back?.focus())
                  }}
                >
                  <Icon name={getSemanticIcon("performance.timeline")} size="small" />
                  {_(E.inboxHistory)}
                </button>
              </Show>
            </Popover>
          </div>
          <Show when={execution.available()}>
            <Show
              when={execution.state.summary}
              fallback={
                <div class="execution-feedback" role="status">
                  <span>{_(execution.state.error ? E.error : E.loading)}</span>
                  <Show when={execution.state.error}>
                    <button type="button" onClick={() => void execution.refresh()}>
                      {_(E.retry)}
                    </button>
                  </Show>
                </div>
              }
            >
              {(summary) => <CompactExecutionOverview summary={summary()} now={now()} />}
            </Show>
          </Show>
        </Show>
        <Show when={history()}>
          <button
            ref={back}
            type="button"
            class="execution-inbox-back"
            onClick={() => {
              setHistory(false)
              queueMicrotask(() => more?.focus())
            }}
          >
            <Icon name={getSemanticIcon("navigation.back")} size="small" />
            {_(E.title)}
          </button>
        </Show>
        <Inbox />
        <div hidden={history()}>
          <Agenda />
          <Show when={execution.available() && tasks().length}>
            <section class="execution-compact-section" aria-label={_(E.tasks)}>
              <h3>{_(E.tasks)}</h3>
              <div class="execution-compact-list execution-task-list" tabindex="0" aria-label={_(E.tasks)}>
                <For each={tasks()}>
                  {(task) => (
                    <div class="execution-compact-row execution-task-row" data-state={compactTaskStatus(task)}>
                      <Tooltip value={taskHelp(task)} placement="top" hideWhenDetached>
                        <button
                          type="button"
                          class="execution-row-main"
                          onClick={() => showFull(task.nodeID ?? undefined)}
                        >
                          <TaskStatusIcon status={compactTaskStatus(task)} />
                          <span class="execution-row-title">{task.title}</span>
                          <span class="execution-row-meta">
                            {task.elapsedMs == null
                              ? ""
                              : executionDuration(
                                  task.elapsedMs + (task.elapsedActive ? now() : 0),
                                  task.elapsedLowerBound,
                                )}
                          </span>
                        </button>
                      </Tooltip>
                      <div class="execution-row-actions">
                        <Show when={cancellableTask(task)}>
                          <button
                            type="button"
                            class="execution-icon-action"
                            aria-label={_(E.cancelTask)}
                            title={_(E.cancelTask)}
                            disabled={pending().has(task.sessionID)}
                            onClick={() => void cancel(task)}
                          >
                            <Icon name={getSemanticIcon("action.stop")} size="small" />
                          </button>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </Popover>
    </Show>
  )
}
