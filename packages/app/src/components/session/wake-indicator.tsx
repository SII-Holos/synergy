import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import type { SessionAgendaItem, SessionAgendaResponse } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useSDK } from "@/context/sdk"
import "./wake-indicator.css"

interface Props {
  sessionID: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function formatWakeTime(nextRunAt: number | null): string {
  if (nextRunAt === null) return "条件触发"

  const delta = nextRunAt - Date.now()
  if (delta < MINUTE) return "即将触发"
  if (delta < HOUR) return `${Math.ceil(delta / MINUTE)} 分钟后`
  if (delta < DAY) return `${Math.ceil(delta / HOUR)} 小时后`

  const date = new Date(nextRunAt)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)

  const sameDay =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
  if (sameDay) return `明天 ${time}`

  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function statusLabel(status: SessionAgendaItem["status"]): string {
  return status === "active" ? "活跃" : "待触发"
}

function formatDuration(value: string | undefined): string | undefined {
  const match = value?.match(/^(\d+)(ms|s|m|h|d|w)$/)
  if (!match) return value
  const amount = Number(match[1])
  const unit = match[2]
  const labels: Record<string, string> = {
    ms: "毫秒",
    s: "秒",
    m: "分钟",
    h: "小时",
    d: "天",
    w: "周",
  }
  return `${amount} ${labels[unit] ?? unit}`
}

function triggerLabel(item: SessionAgendaItem): string {
  const labels = item.triggers.map((trigger) => {
    switch (trigger.type) {
      case "at":
        return "一次性"
      case "delay":
        return `延迟 ${formatDuration(trigger.delay) ?? ""}`.trim()
      case "every":
        return `每 ${formatDuration(trigger.interval) ?? ""}`.trim()
      case "cron":
        return "定时计划"
      case "watch":
        return "条件触发"
      case "webhook":
        return "Webhook 触发"
    }
  })
  return labels.length > 0 ? labels.join("、") : "待触发"
}

function itemTargetsSession(item: { origin?: { sessionID?: string } } | undefined, sessionID: string): boolean {
  return item?.origin?.sessionID === sessionID
}

export function SessionAgendaWakeIndicator(props: Props) {
  const sdk = useSDK()
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
  // Deleted agenda events only include item ID and scope, so refetch conservatively.
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
  const nextWakeLabel = createMemo(() => formatWakeTime(agenda()?.items[0]?.nextRunAt ?? null))

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
            <Tooltip placement="top" value={`定时唤醒：${agenda()?.count ?? 0} 项，最近 ${nextWakeLabel()}`}>
              <button
                type="button"
                class="session-agenda-wake-trigger"
                data-expanded={open() ? "true" : "false"}
                aria-label={`定时唤醒，${agenda()?.count ?? 0} 项待唤醒，点击查看详情`}
              >
                <Icon name="clock" size="small" />
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
                <Icon name="clock" size="small" />
                <span>定时唤醒</span>
              </div>
              <div class="session-agenda-wake-panel-description">
                这个会话接下来会被 {agenda()?.count ?? 0} 个任务唤醒
              </div>
            </div>
            <div class="session-agenda-wake-list">
              <For each={displayedItems()}>
                {(item) => (
                  <div class="session-agenda-wake-row">
                    <span class="session-agenda-wake-dot" aria-hidden="true" />
                    <div class="session-agenda-wake-row-main">
                      <div class="session-agenda-wake-time">{formatWakeTime(item.nextRunAt)}</div>
                      <div class="session-agenda-wake-title" title={item.title}>
                        {item.title}
                      </div>
                      <div class="session-agenda-wake-meta">
                        {triggerLabel(item)} · {statusLabel(item.status)}
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={(agenda()?.items.length ?? 0) > 3}>
              <div class="session-agenda-wake-footer">
                <button type="button" class="session-agenda-wake-footer-button" onClick={() => setShowAll(!showAll())}>
                  {showAll() ? "收起" : `查看全部 ${agenda()?.items.length ?? 0} 项`}
                </button>
              </div>
            </Show>
          </div>
        </Popover>
      </div>
    </Show>
  )
}
