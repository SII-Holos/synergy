import { createSignal, For, Show, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useExecution } from "@/context/execution"
import { useSDK } from "@/context/sdk"
import { E } from "./i18n"
import { ExecutionOverview, executionDuration } from "./overview"
import "./execution.css"

export function TaskDetailsPopover() {
  const { _, i18n } = useLingui()
  const execution = useExecution()
  const sdk = useSDK()
  const params = useParams()
  const [open, setOpen] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  const toggle = (value: boolean) => {
    setOpen(value)
    if (timer) clearInterval(timer)
    if (value) {
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), 1000)
      if (!execution.state.summary) void execution.refresh()
    }
  }
  onCleanup(() => timer && clearInterval(timer))
  const number = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  const showFull = (runID?: string, nodeID?: string) => {
    toggle(false)
    void execution.open(runID, nodeID)
  }
  return (
    <Show when={params.id && execution.available()}>
      <Popover
        title={_(E.title)}
        class="execution-popover"
        placement="bottom-end"
        gutter={8}
        open={open()}
        onOpenChange={toggle}
        triggerAs={(trigger) => (
          <button
            {...trigger}
            type="button"
            class="stb-icon-btn execution-trigger"
            aria-label={_(E.title)}
            aria-expanded={open()}
            data-state={execution.state.summary?.status}
          >
            <Icon name={getSemanticIcon("session.taskDetails")} size="normal" />
          </button>
        )}
      >
        <Show
          when={execution.state.summary}
          fallback={
            <div class="execution-feedback">
              <p>{_(execution.state.error ? E.error : E.loading)}</p>
              <Show when={execution.state.error}>
                <button type="button" onClick={() => void execution.refresh()}>
                  {_(E.retry)}
                </button>
              </Show>
            </div>
          }
        >
          {(summary) => (
            <>
              <ExecutionOverview summary={summary()} now={now()} quick />
              <Show when={summary().tasks.length}>
                <div class="execution-task-list">
                  <For each={summary().tasks.slice(0, 4)}>
                    {(task) => (
                      <button
                        type="button"
                        class="execution-task-row"
                        onClick={() => showFull(undefined, task.nodeID ?? undefined)}
                      >
                        <span>
                          <strong>{task.title}</strong>
                          <small data-state={task.status}>{_(E[task.status])}</small>
                        </span>
                        <span>
                          {task.elapsedMs != null
                            ? executionDuration(
                                task.elapsedMs + (task.elapsedActive ? Math.max(0, now() - summary().computedAt) : 0),
                              )
                            : "—"}
                          <small>
                            {task.tokens.known || (task.tokens.total != null && task.runs.length)
                              ? (task.tokens.unknown ? "≥ " : "") + number(task.tokens.known)
                              : "—"}
                          </small>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <details class="execution-secondary">
                <summary>{_(E.more)}</summary>
                <dl>
                  <div>
                    <dt>{_(E.own)}</dt>
                    <dd>{number(summary().own.tokens.total.known)}</dd>
                  </div>
                  <div>
                    <dt>{_(E.children)}</dt>
                    <dd>{number(summary().descendants.tokens.total.known)}</dd>
                  </div>
                  <div>
                    <dt>{_(E.input)}</dt>
                    <dd>{number(summary().accounting.tokens.input.known)}</dd>
                  </div>
                  <div>
                    <dt>{_(E.output)}</dt>
                    <dd>{number(summary().accounting.tokens.output.known)}</dd>
                  </div>
                  <div>
                    <dt>{_(E.environment)}</dt>
                    <dd>{_(sdk.connected() ? E.connected : E.disconnected)}</dd>
                  </div>
                </dl>
              </details>
            </>
          )}
        </Show>
        <button type="button" class="execution-full-link" onClick={() => showFull()}>
          {_(E.full)}
          <Icon name={getSemanticIcon("action.open")} size="small" />
        </button>
      </Popover>
    </Show>
  )
}
