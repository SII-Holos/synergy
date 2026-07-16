import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import type { SessionAgendaItem, SessionAgendaResponse } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useSDK } from "@/context/sdk"
import { useLocale } from "@/context/locale"
import "./wake-indicator.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { W, formatWakeTime, statusLabel, triggerLabel, itemTargetsSession } from "./wake-indicator-model"

export {
  W,
  formatWakeTime,
  formatDuration,
  statusLabel,
  triggerLabel,
  itemTargetsSession,
} from "./wake-indicator-model"

interface Props {
  sessionID: string
}

export function SessionAgendaWakeIndicator(props: Props) {
  const sdk = useSDK()
  const { i18n, controller } = useLocale()
  const locale = () => controller.epoch().locale
  const [open, setOpen] = createSignal(false)
  const [showAll, setShowAll] = createSignal(false)
  const [lastResponse, setLastResponse] = createSignal<SessionAgendaResponse>()

  const [response, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const result = await sdk.client.session.agenda({ sessionID, limit: 6 })
      return result.data
    },
  )

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setOpen(false)
        setShowAll(false)
        setLastResponse(undefined)
      },
    ),
  )

  createEffect(() => {
    const data = response()
    if (data) setLastResponse(data)
  })

  const unsubCreated = sdk.event.on("agenda.item.created", (event) => {
    if (itemTargetsSession(event.properties.item, props.sessionID)) refetch()
  })
  const unsubUpdated = sdk.event.on("agenda.item.updated", (event) => {
    if (itemTargetsSession(event.properties.item, props.sessionID)) refetch()
  })
  const unsubDeleted = sdk.event.on("agenda.item.deleted", () => refetch())
  onCleanup(() => {
    unsubCreated()
    unsubUpdated()
    unsubDeleted()
  })

  const agenda = createMemo(() => lastResponse())
  const visible = createMemo(() => agenda()?.hasActiveAgenda ?? false)
  const displayedItems = createMemo(() => {
    const items = agenda()?.items ?? []
    return showAll() ? items : items.slice(0, 3)
  })
  const nextWakeLabel = createMemo(() =>
    formatWakeTime(agenda()?.items[0]?.nextRunAt ?? null, { i18n, locale: locale() }),
  )

  function handleOpenChange(open: boolean) {
    setOpen(open)
    if (!open) setShowAll(false)
    if (open) refetch()
  }

  return (
    <Show when={visible()}>
      <div>
        <Popover
          open={open()}
          onOpenChange={handleOpenChange}
          placement="top-end"
          gutter={8}
          class="session-agenda-wake-panel"
          trigger={
            <Tooltip
              placement="top"
              value={i18n._({ ...W.tooltip, values: { count: agenda()?.count ?? 0, time: nextWakeLabel() } })}
            >
              <button
                type="button"
                class="session-agenda-wake-trigger"
                data-expanded={open() ? "true" : "false"}
                aria-label={i18n._({ ...W.ariaLabel, values: { count: agenda()?.count ?? 0 } })}
              >
                <Icon name={getSemanticIcon("agenda.main")} size="small" />
                <Show when={(agenda()?.count ?? 0) > 0}>
                  <span class="session-agenda-wake-badge">{agenda()?.count}</span>
                </Show>
              </button>
            </Tooltip>
          }
        >
          <div class="session-agenda-wake-panel-body">
            <div class="session-agenda-wake-panel-header">
              <div class="session-agenda-wake-panel-title">
                <Icon name={getSemanticIcon("agenda.main")} size="small" />
                <span>{i18n._(W.panelTitle)}</span>
              </div>
              <div class="session-agenda-wake-panel-description">
                {i18n._({ ...W.panelDescription, values: { count: agenda()?.count ?? 0 } })}
              </div>
            </div>
            <div class="session-agenda-wake-list">
              <For each={displayedItems()}>
                {(item) => (
                  <div class="session-agenda-wake-row">
                    <span class="session-agenda-wake-dot" aria-hidden="true" />
                    <div class="session-agenda-wake-row-main">
                      <div class="session-agenda-wake-time">
                        {formatWakeTime(item.nextRunAt, { i18n, locale: locale() })}
                      </div>
                      <div class="session-agenda-wake-title" title={item.title}>
                        {item.title}
                      </div>
                      <div class="session-agenda-wake-meta">
                        {triggerLabel(item, { i18n })} · {statusLabel(item.status, { i18n })}
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={(agenda()?.items.length ?? 0) > 3}>
              <div class="session-agenda-wake-footer">
                <button type="button" class="session-agenda-wake-footer-button" onClick={() => setShowAll(!showAll())}>
                  {showAll()
                    ? i18n._(W.collapse)
                    : i18n._({ ...W.showAll, values: { count: agenda()?.items.length ?? 0 } })}
                </button>
              </div>
            </Show>
          </div>
        </Popover>
      </div>
    </Show>
  )
}
