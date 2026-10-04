import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgendaItem, SessionAgendaItem, SessionAgendaResponse } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import { useLocale } from "@/context/locale"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { agendaActionConfirm } from "@/components/dialog/confirm-copy"
import type { AgendaAction } from "@/components/agenda/detail-actions"
import { A } from "@/components/agenda/agenda-i18n"
import { W, formatWakeTime, triggerLabel, itemTargetsSession } from "./wake-indicator-model"

export function SessionAgendaWakeIndicator(props: { sessionID: string; active: boolean; onDetailOpened?: () => void }) {
  const sdk = useSDK()
  const { i18n, fmt } = useLocale()
  const dialog = useDialog()
  const confirm = useConfirm()
  const [state, setState] = createStore({
    items: [] as SessionAgendaItem[],
    offset: 0,
    hasMore: false,
    loading: false,
    error: false,
  })
  const [pending, setPending] = createSignal<Set<string>>(new Set())
  const [resolving, setResolving] = createSignal<Set<string>>(new Set())
  const busy = (id: string) => pending().has(id) || resolving().has(id)
  let controller: AbortController | undefined
  let generation = 0
  let disposed = false
  let owner = ""
  let ownerClient: typeof sdk.client | undefined
  const load = async (append = false) => {
    if (!props.active || (append && (state.loading || !state.hasMore || state.error))) return
    const sessionID = props.sessionID
    const client = sdk.client
    controller?.abort()
    const abort = new AbortController()
    controller = abort
    const request = ++generation
    const current = () =>
      !disposed && request === generation && sessionID === props.sessionID && client === sdk.client && props.active
    const target = append ? 20 : Math.max(20, state.items.length)
    let offset = append ? state.offset : 0
    const items: SessionAgendaItem[] = []
    let response: SessionAgendaResponse | undefined
    setState({ loading: true, error: false })
    try {
      do {
        response = (
          await client.session.agenda({ sessionID, offset, limit: 20 }, { signal: abort.signal, throwOnError: true })
        ).data
        if (!current()) return
        if (response.sessionID !== sessionID) throw new Error("Scheduled activity belongs to another session")
        items.push(...response.items)
        offset = response.offset + response.items.length
      } while (!append && response.hasMore && response.items.length && items.length < target)
      if (!current() || !response) return
      const merged = new Map((append ? state.items : []).map((item) => [item.itemID, item]))
      for (const item of items) merged.set(item.itemID, item)
      setState({
        items: [...merged.values()],
        offset,
        hasMore: response.hasMore && response.items.length > 0,
        loading: false,
      })
    } catch {
      if (current()) setState({ error: true, loading: false })
    }
  }
  const refresh = () => {
    if (props.active) void load()
  }
  createEffect(
    on(
      () => [props.sessionID, sdk.client, props.active] as const,
      ([sessionID, client, active]) => {
        controller?.abort()
        generation++
        setState("loading", false)
        if (owner !== sessionID || ownerClient !== client) {
          owner = sessionID
          ownerClient = client
          setState({ items: [], offset: 0, hasMore: false, error: false })
        }
        if (active) refresh()
      },
    ),
  )
  const targets = (item: { id?: string; origin?: { sessionID?: string } }) =>
    itemTargetsSession(item, props.sessionID) || state.items.some((entry) => entry.itemID === item.id)
  const created = sdk.event.on("agenda.item.created", (event) => {
    if (targets(event.properties.item)) refresh()
  })
  const updated = sdk.event.on("agenda.item.updated", (event) => {
    if (targets(event.properties.item)) refresh()
  })
  const deleted = sdk.event.on("agenda.item.deleted", refresh)
  onCleanup(() => {
    disposed = true
    generation++
    controller?.abort()
    created()
    updated()
    deleted()
  })
  const perform = async (item: AgendaItem, action: AgendaAction, client: typeof sdk.client) => {
    if (pending().has(item.id)) return
    const query = { id: item.id, scopeID: item.origin.scope.id }
    setPending((value) => new Set([...value, item.id]))
    try {
      const actions = {
        pause: () => client.agenda.pause(query, { throwOnError: true }),
        cancel: () => client.agenda.cancel(query, { throwOnError: true }),
        activate: () => client.agenda.activate(query, { throwOnError: true }),
        trigger: () => client.agenda.trigger(query, { throwOnError: true }),
        complete: () => client.agenda.complete(query, { throwOnError: true }),
        remove: () => client.agenda.remove(query, { throwOnError: true }),
      }
      await actions[action]()
      if (!disposed) refresh()
    } catch (error) {
      if (!disposed) showToast({ type: "error", title: i18n._(W.actionFailed) })
      throw error
    } finally {
      setPending((value) => new Set([...value].filter((id) => id !== item.id)))
    }
  }
  const act = (item: AgendaItem, action: AgendaAction, client: typeof sdk.client): Promise<void> => {
    if (action !== "cancel" && action !== "remove") return perform(item, action, client)
    return new Promise((resolve, reject) =>
      confirm.show({
        ...agendaActionConfirm(action, item.title),
        onConfirm: () => perform(item, action, client),
        onConfirmed: resolve,
        onDismiss: () => reject(new Error("Scheduled task action dismissed")),
      }),
    )
  }
  const resolveItem = async (item: SessionAgendaItem, client: typeof sdk.client) =>
    (await client.agenda.get({ id: item.itemID }, { throwOnError: true })).data
  const action = async (item: SessionAgendaItem, kind: "pause" | "cancel") => {
    if (busy(item.itemID)) return
    const client = sdk.client
    const sessionID = props.sessionID
    setResolving((value) => new Set([...value, item.itemID]))
    try {
      let value: AgendaItem
      try {
        value = await resolveItem(item, client)
      } catch {
        if (!disposed) showToast({ type: "error", title: i18n._(W.loadFailed) })
        return
      }
      if (disposed || !props.active || props.sessionID !== sessionID || sdk.client !== client) return
      await act(value, kind, client)
    } catch {
    } finally {
      if (!disposed) setResolving((value) => new Set([...value].filter((id) => id !== item.itemID)))
    }
  }
  const detail = async (item: SessionAgendaItem) => {
    const client = sdk.client
    const sessionID = props.sessionID
    try {
      const [value, module] = await Promise.all([
        resolveItem(item, client),
        import("@/components/agenda/session-item-dialog"),
      ])
      if (disposed || !props.active || props.sessionID !== sessionID || sdk.client !== client) return
      dialog.show(() => (
        <module.SessionAgendaItemDialog
          item={value}
          client={client}
          onAction={(item, action) => act(item, action, client)}
        />
      ))
      props.onDetailOpened?.()
    } catch {
      if (!disposed) showToast({ type: "error", title: i18n._(W.loadFailed) })
    }
  }
  return (
    <Show when={state.items.length || state.error}>
      <section class="execution-compact-section" aria-label={i18n._(W.tasksTitle)}>
        <h3>{i18n._(W.tasksTitle)}</h3>
        <div
          class="execution-compact-list execution-agenda-list"
          tabindex="0"
          aria-label={i18n._(W.tasksTitle)}
          onScroll={(event) => {
            const el = event.currentTarget
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) void load(true)
          }}
        >
          <For each={state.items}>
            {(item) => (
              <div class="execution-compact-row execution-agenda-row">
                <Tooltip
                  value={`${item.title}\n${triggerLabel(item, { i18n })} · ${formatWakeTime(item.nextRunAt, { i18n, fmt })}`}
                  placement="top"
                  hideWhenDetached
                >
                  <button type="button" class="execution-row-main" onClick={() => void detail(item)}>
                    <Icon name={getSemanticIcon("agenda.main")} size="small" />
                    <span class="execution-row-title">{item.title}</span>
                    <span class="execution-row-meta">{triggerLabel(item, { i18n })}</span>
                  </button>
                </Tooltip>
                <div class="execution-row-actions">
                  <Show when={item.status === "active"}>
                    <button
                      type="button"
                      class="execution-icon-action"
                      aria-label={i18n._(A.actionPause)}
                      title={i18n._(A.actionPause)}
                      disabled={busy(item.itemID)}
                      onClick={() => void action(item, "pause")}
                    >
                      <Icon name={getSemanticIcon("session.pause")} size="small" />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="execution-icon-action"
                    aria-label={i18n._(A.actionCancel)}
                    title={i18n._(A.actionCancel)}
                    disabled={busy(item.itemID)}
                    onClick={() => void action(item, "cancel")}
                  >
                    <Icon name={getSemanticIcon("action.stop")} size="small" />
                  </button>
                </div>
              </div>
            )}
          </For>
          <Show when={state.hasMore && !state.error}>
            <button type="button" class="execution-load-more" disabled={state.loading} onClick={() => void load(true)}>
              {i18n._(W.more)}
            </button>
          </Show>
        </div>
        <Show when={state.error}>
          <div class="execution-compact-feedback" role="alert">
            <button type="button" onClick={refresh}>
              {i18n._(W.loadFailed)}
            </button>
          </div>
        </Show>
      </section>
    </Show>
  )
}
