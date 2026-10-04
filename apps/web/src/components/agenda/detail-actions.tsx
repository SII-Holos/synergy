import { createSignal, Show } from "solid-js"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { A } from "./agenda-i18n"
import { triggerActionLabel } from "./shared"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"

export type AgendaAction = "trigger" | "activate" | "pause" | "complete" | "cancel" | "remove"

export function AgendaDetailActions(props: {
  item: AgendaItem
  isLoading: (id: string, action: string) => boolean
  isDone: (id: string, action: string) => boolean
  onAction: (action: AgendaAction) => void
  _: (d: { id: string; message: string }) => string
}) {
  const { _ } = props
  const { i18n } = useLocale()
  const status = () => props.item.status

  const [moreOpen, setMoreOpen] = createSignal(false)
  const moreLabel = () => _({ id: "app.agenda.action.more", message: "More actions" })

  return (
    <div class="flex items-center gap-1.5 flex-wrap">
      <Show when={status() === "active" || status() === "paused" || status() === "pending"}>
        <ActionButton
          label={translateDescriptor(triggerActionLabel(status()), i18n)}
          doneLabel={_({ id: "app.agenda.action.accepted", message: "Submitted" })}
          loading={props.isLoading(props.item.id, "trigger")}
          done={props.isDone(props.item.id, "trigger")}
          onClick={() => props.onAction("trigger")}
          variant="primary"
        />
      </Show>
      <Show when={status() === "paused" || status() === "pending"}>
        <ActionButton
          label={_(A.actionActivate)}
          loading={props.isLoading(props.item.id, "activate")}
          onClick={() => props.onAction("activate")}
        />
      </Show>
      <Show when={status() === "active"}>
        <ActionButton
          label={_(A.actionPause)}
          loading={props.isLoading(props.item.id, "pause")}
          onClick={() => props.onAction("pause")}
        />
      </Show>
      <Popover
        modal
        open={moreOpen()}
        onOpenChange={setMoreOpen}
        variant="menu"
        placement="top-end"
        title={moreLabel()}
        class="agenda-more-menu"
        triggerAs={(triggerProps) => (
          <button {...triggerProps} type="button" class="agenda-secondary-action">
            <Icon name={getSemanticIcon("action.more")} size="small" />
            {moreLabel()}
          </button>
        )}
      >
        <div class="flex flex-col gap-1" role="group" aria-label={moreLabel()}>
          <Show when={status() !== "done" && status() !== "cancelled"}>
            <ActionButton
              label={_(A.actionComplete)}
              loading={props.isLoading(props.item.id, "complete")}
              onClick={() => {
                setMoreOpen(false)
                props.onAction("complete")
              }}
            />
          </Show>
          <Show when={status() !== "cancelled"}>
            <ActionButton
              label={_(A.actionCancel)}
              loading={props.isLoading(props.item.id, "cancel")}
              onClick={() => {
                setMoreOpen(false)
                props.onAction("cancel")
              }}
            />
          </Show>
          <ActionButton
            label={_(A.detailDelete)}
            variant="danger"
            loading={props.isLoading(props.item.id, "remove")}
            onClick={() => {
              setMoreOpen(false)
              props.onAction("remove")
            }}
          />
        </div>
      </Popover>
    </div>
  )
}

function ActionButton(props: {
  label: string
  loading: boolean
  done?: boolean
  doneLabel?: string
  onClick: () => void
  variant?: "primary" | "danger" | "default"
}) {
  const variant = () => props.variant ?? "default"
  const done = () => props.done ?? false

  return (
    <button
      type="button"
      classList={{
        "min-h-9 px-3 py-1.5 rounded-lg app-panel-row-title border transition-colors": true,
        "border-icon-success-base/25 bg-icon-success-base/8 text-text-on-success-base": done(),
        "border-border-base/45 bg-text-strong text-background-base hover:bg-text-base":
          variant() === "primary" && !props.loading && !done(),
        "border-text-diff-delete-base/25 bg-text-diff-delete-base/6 text-text-diff-delete-base hover:bg-text-diff-delete-base/10":
          variant() === "danger" && !props.loading && !done(),
        "border-border-base/45 bg-surface-raised-base text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
          variant() === "default" && !props.loading && !done(),
        "opacity-50 pointer-events-none": props.loading || done(),
      }}
      onClick={props.onClick}
      disabled={props.loading || done()}
    >
      <Show when={props.loading} fallback={done() ? props.doneLabel : props.label}>
        <Spinner class="size-3 inline-block mr-1" />
        {props.label}
      </Show>
    </button>
  )
}
