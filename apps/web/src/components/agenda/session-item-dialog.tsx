import { createResource, createSignal, onCleanup, Show } from "solid-js"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useLocale } from "@/context/locale"
import { AgendaDetails } from "./details"
import { AgendaDetailActions, type AgendaAction } from "./detail-actions"
import { W } from "@/components/session/wake-indicator-model"
import "./agenda-dialog.css"

export function SessionAgendaItemDialog(props: {
  item: AgendaItem
  client: SynergyClient
  onAction: (item: AgendaItem, action: AgendaAction) => Promise<void>
}) {
  const client = props.client
  const [pending, setPending] = createSignal(false)
  let disposed = false
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }, values?: Record<string, unknown>) =>
    i18n._(values ? { ...d, values } : d)
  let controller: AbortController | undefined
  let itemController: AbortController | undefined
  const [item, { refetch: refetchItem }] = createResource(
    async () => {
      itemController?.abort()
      itemController = new AbortController()
      return (
        await client.agenda.get(
          { id: props.item.id, scopeID: props.item.origin.scope.id },
          { signal: itemController.signal, throwOnError: true },
        )
      ).data
    },
    { initialValue: props.item },
  )
  const current = () => (item.error ? props.item : item.latest)
  const [runs, { refetch }] = createResource(
    async () => {
      controller?.abort()
      controller = new AbortController()
      return (
        await client.agenda.runs(
          { id: props.item.id, scopeID: props.item.origin.scope.id },
          { signal: controller.signal, throwOnError: true },
        )
      ).data
    },
    { initialValue: undefined },
  )
  onCleanup(() => {
    disposed = true
    controller?.abort()
    itemController?.abort()
  })
  const action = async (value: AgendaAction) => {
    if (pending()) return
    setPending(true)
    try {
      await props.onAction(current(), value)
      if (!disposed) await refetchItem()
    } catch {
    } finally {
      if (!disposed) setPending(false)
    }
  }
  return (
    <Dialog
      size="wide"
      class="app-panel-detail-dialog agenda-detail-dialog"
      title={current().title}
      footer={
        <AgendaDetailActions
          item={current()}
          isLoading={pending}
          isDone={() => false}
          onAction={(value) => void action(value)}
          _={_}
        />
      }
    >
      <Show when={item.error}>
        <button type="button" onClick={() => void refetchItem()}>
          {_(W.loadFailed)}
        </button>
      </Show>
      <AgendaDetails
        item={current()}
        now={Date.now()}
        scopeName={
          current().origin.scope.type === "home"
            ? _({ id: "app.sidebar.section.home", message: "Home" })
            : current().origin.scope.id
        }
        runs={runs.error ? undefined : runs.latest}
        runsError={Boolean(runs.error)}
        onRetry={() => void refetch()}
        _={_}
      />
    </Dialog>
  )
}
