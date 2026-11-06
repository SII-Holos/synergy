import { createEffect, createSignal, For, on, Show, type Accessor, type ComponentProps, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { ErrorCard } from "@ericsanchezok/synergy-ui/error-card"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { requestErrorMessage } from "@/utils/error"

export type ExecutionDetailView = "result" | "attachments" | "process" | "diagnostics"

export function ExecutionDetailLayout(props: {
  identity: string
  id: string
  kind: string
  title: string
  icon: ComponentProps<typeof Icon>["name"]
  brief?: string
  meta?: JSX.Element
  details?: JSX.Element
  actions?: JSX.Element
  views: ExecutionDetailView[]
  attachmentCount?: number
  diagnosticsLabel?: string
  loading: boolean
  error?: unknown
  retry: () => unknown
  bodyRef?: (element: HTMLElement) => void
  onScroll?: () => void
  children: (view: Accessor<ExecutionDetailView>) => JSX.Element
}) {
  const { _ } = useLingui()
  const [selected, setSelected] = createSignal<ExecutionDetailView>("result")
  const view = () => (props.views.includes(selected()) ? selected() : "result")
  createEffect(() => {
    if (!props.views.includes(selected())) setSelected("result")
  })
  createEffect(
    on(
      () => props.identity,
      () => setSelected("result"),
    ),
  )
  const panelID = (name: string) => `execution-${props.id}-${name}`
  const tabKey = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const tabs = props.views
    const index = tabs.indexOf(view())
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    setSelected(tabs[next]!)
    const root = (event.currentTarget as HTMLElement).parentElement
    queueMicrotask(() => root?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
  }
  const label = (name: ExecutionDetailView) =>
    name === "result"
      ? _({ id: "session.execution.result", message: "Result" })
      : name === "attachments"
        ? _({
            id: "session.execution.attachments",
            message: "Attachments ({count})",
            values: { count: props.attachmentCount ?? 0 },
          })
        : name === "process"
          ? _({ id: "session.process.execution", message: "Execution process" })
          : (props.diagnosticsLabel ?? _({ id: "session.execution.diagnosticsOnly", message: "Diagnostics" }))
  return (
    <div data-component="execution-detail" data-kind={props.kind} aria-busy={props.loading}>
      <header data-slot="execution-detail-heading">
        <div data-slot="execution-detail-resource">
          <Icon name={props.icon} size="normal" />
          <h2>{props.title}</h2>
        </div>
        {props.actions}
        <Show when={props.brief}>
          <p data-slot="execution-brief">{props.brief}</p>
        </Show>
        <p data-slot="execution-process-meta">{props.meta}</p>
        {props.details}
      </header>
      <div data-slot="execution-detail-toolbar">
        <div role="tablist" aria-label={_({ id: "session.execution.detailViews", message: "Execution detail views" })}>
          <For each={props.views}>
            {(name) => (
              <button
                type="button"
                role="tab"
                id={panelID(`${name}-tab`)}
                aria-controls={panelID("panel")}
                aria-selected={view() === name}
                tabindex={view() === name ? 0 : -1}
                onClick={() => setSelected(name)}
                onKeyDown={tabKey}
              >
                {label(name)}
              </button>
            )}
          </For>
        </div>
      </div>
      <section
        ref={props.bodyRef}
        data-slot="execution-detail-body"
        data-scroll-viewport="vertical"
        onScroll={props.onScroll}
      >
        <Show when={props.error && (!(props.error instanceof Error) || props.error.name !== "AbortError")}>
          <ErrorCard
            error={requestErrorMessage(
              props.error,
              _({ id: "session.execution.loadFailed", message: "Unable to load execution details." }),
            )}
            actions={
              <Button
                variant="ghost"
                size="small"
                disabled={props.loading}
                onClick={() => void Promise.resolve(props.retry()).catch(() => undefined)}
              >
                {_({ id: "session.content.retry", message: "Retry loading content" })}
              </Button>
            }
          />
        </Show>
        <div role="tabpanel" id={panelID("panel")} aria-labelledby={panelID(`${view()}-tab`)} tabindex="0">
          {props.children(view)}
        </div>
      </section>
    </div>
  )
}
