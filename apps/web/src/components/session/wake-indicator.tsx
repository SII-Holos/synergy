import { createResource, For, onCleanup, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useLocale } from "@/context/locale"
import { W, formatWakeTime, statusLabel, triggerLabel, itemTargetsSession } from "./wake-indicator-model"
import "./wake-indicator.css"

export function SessionAgendaWakeIndicator(props: { sessionID: string; active: boolean }) {
  const sdk = useSDK()
  const { i18n, fmt } = useLocale()
  let controller: AbortController | undefined
  const [response, { refetch }] = createResource(
    () => props.active && { sessionID: props.sessionID, client: sdk.client },
    async ({ sessionID, client }) => {
      controller?.abort()
      controller = new AbortController()
      return (await client.session.agenda({ sessionID, limit: 6 }, { signal: controller.signal, throwOnError: true }))
        .data
    },
  )
  const refresh = () => {
    if (props.active) void refetch()
  }
  const created = sdk.event.on("agenda.item.created", (event) => {
    if (itemTargetsSession(event.properties.item, props.sessionID)) refresh()
  })
  const updated = sdk.event.on("agenda.item.updated", (event) => {
    if (itemTargetsSession(event.properties.item, props.sessionID)) refresh()
  })
  const deleted = sdk.event.on("agenda.item.deleted", refresh)
  onCleanup(() => {
    controller?.abort()
    created()
    updated()
    deleted()
  })
  return (
    <Show when={response.error || response()?.hasActiveAgenda}>
      <details class="execution-secondary">
        <summary>{i18n._(W.panelTitle)}</summary>
        <Show
          when={response.error}
          fallback={
            <div class="session-agenda-wake-list">
              <For each={response()?.items}>
                {(item) => (
                  <div class="session-agenda-wake-row">
                    <div class="session-agenda-wake-row-main">
                      <div class="session-agenda-wake-time">{formatWakeTime(item.nextRunAt, { i18n, fmt })}</div>
                      <div class="session-agenda-wake-title">{item.title}</div>
                      <div class="session-agenda-wake-meta">
                        {triggerLabel(item, { i18n })} · {statusLabel(item.status, { i18n })}
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <button type="button" onClick={refresh}>
            {i18n._({ id: "session.agenda.retry", message: "Could not load scheduled activity. Retry" })}
          </button>
        </Show>
      </details>
    </Show>
  )
}
