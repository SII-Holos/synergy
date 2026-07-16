import type { I18n } from "@lingui/core"
import type { SessionAgendaItem } from "@ericsanchezok/synergy-sdk/client"
import type { IntlFormatter } from "@/context/locale/formatter"

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Runtime translation descriptors for all wake-indicator UI strings.
 *  Each is a base MessageDescriptor with `id` + English `message`.
 *  Call sites spread in `values` when the message contains ICU placeholders. */
export const W = {
  conditional: { id: "session.agenda.wake.conditional", message: "Conditional" },
  imminent: { id: "session.agenda.wake.imminent", message: "Imminent" },
  inMinutes: { id: "session.agenda.wake.inMinutes", message: "{minutes, plural, one {# minute} other {# minutes}}" },
  inHours: { id: "session.agenda.wake.inHours", message: "{hours, plural, one {#h} other {#h}}" },
  tomorrowAt: { id: "session.agenda.wake.tomorrowAt", message: "Tomorrow at {time}" },

  statusActive: { id: "session.agenda.wake.status.active", message: "Active" },
  statusPending: { id: "session.agenda.wake.status.pending", message: "Pending" },

  triggerAt: { id: "session.agenda.wake.trigger.at", message: "One-time" },
  triggerDelay: { id: "session.agenda.wake.trigger.delay", message: "Delay {duration}" },
  triggerEvery: { id: "session.agenda.wake.trigger.every", message: "Every {duration}" },
  triggerCron: { id: "session.agenda.wake.trigger.cron", message: "Scheduled" },
  triggerWatch: { id: "session.agenda.wake.trigger.watch", message: "Conditional" },
  triggerWebhook: { id: "session.agenda.wake.trigger.webhook", message: "Webhook" },
  triggerPending: { id: "session.agenda.wake.trigger.pending", message: "Pending" },

  panelTitle: { id: "session.agenda.wake.panel.title", message: "Scheduled wake" },
  panelDescription: {
    id: "session.agenda.wake.panel.description",
    message: "This session will be woken by {count, plural, one {# task} other {# tasks}}",
  },
  tooltip: {
    id: "session.agenda.wake.tooltip",
    message: "Scheduled wake: {count, plural, one {# task} other {# tasks}}, next {time}",
  },
  ariaLabel: {
    id: "session.agenda.wake.ariaLabel",
    message: "Scheduled wake, {count, plural, one {# task} other {# tasks}} pending, click to view details",
  },

  collapse: { id: "session.agenda.wake.collapse", message: "Collapse" },
  showAll: { id: "session.agenda.wake.showAll", message: "Show all {count, plural, one {# item} other {# items}}" },

  joinToken: { id: "session.agenda.wake.join", message: ", " },
}

function durationUnitLabel(unit: string, i18n: I18n): string {
  if (unit === "ms") return i18n._({ id: "session.agenda.wake.unit.ms", message: "ms" })
  if (unit === "s") return i18n._({ id: "session.agenda.wake.unit.s", message: "seconds" })
  if (unit === "m") return i18n._({ id: "session.agenda.wake.unit.m", message: "minutes" })
  if (unit === "h") return i18n._({ id: "session.agenda.wake.unit.h", message: "hours" })
  if (unit === "d") return i18n._({ id: "session.agenda.wake.unit.d", message: "days" })
  return i18n._({ id: "session.agenda.wake.unit.w", message: "weeks" })
}

function formatTimeForLocale(date: Date, fmt: IntlFormatter): string {
  return fmt.time(date, { hour12: false })
}

function formatDateTimeForLocale(date: Date, fmt: IntlFormatter): string {
  return fmt.dateTime(date)
}

export function formatWakeTime(
  nextRunAt: number | null,
  deps: { i18n: I18n; fmt: IntlFormatter; now?: number },
): string {
  if (nextRunAt === null) return deps.i18n._(W.conditional)
  const now = new Date(deps.now ?? Date.now())
  const delta = nextRunAt - now.getTime()
  if (delta < MINUTE) return deps.i18n._(W.imminent)
  if (delta < HOUR) return deps.i18n._({ ...W.inMinutes, values: { minutes: Math.ceil(delta / MINUTE) } })

  const date = new Date(nextRunAt)
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)

  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  const time = formatTimeForLocale(date, deps.fmt)
  if (isTomorrow) return deps.i18n._({ ...W.tomorrowAt, values: { time } })
  if (delta < DAY) return deps.i18n._({ ...W.inHours, values: { hours: Math.ceil(delta / HOUR) } })

  return formatDateTimeForLocale(date, deps.fmt)
}

export function statusLabel(status: SessionAgendaItem["status"], deps: { i18n: I18n }): string {
  return status === "active" ? deps.i18n._(W.statusActive) : deps.i18n._(W.statusPending)
}

export function formatDuration(value: string | undefined, deps: { i18n: I18n }): string | undefined {
  const match = value?.match(/^(\d+)(ms|s|m|h|d|w)$/)
  if (!match) return value
  const amount = Number(match[1])
  const unit = match[2]
  const unitLabel = durationUnitLabel(unit, deps.i18n)
  return `${amount} ${unitLabel}`
}

export function triggerLabel(item: SessionAgendaItem, deps: { i18n: I18n }): string {
  const labels = item.triggers.map((trigger) => {
    switch (trigger.type) {
      case "at":
        return deps.i18n._(W.triggerAt)
      case "delay":
        return deps.i18n._({
          ...W.triggerDelay,
          values: { duration: (formatDuration(trigger.delay, deps) ?? "").trim() },
        })
      case "every":
        return deps.i18n._({
          ...W.triggerEvery,
          values: { duration: (formatDuration(trigger.interval, deps) ?? "").trim() },
        })
      case "cron":
        return deps.i18n._(W.triggerCron)
      case "watch":
        return deps.i18n._(W.triggerWatch)
      case "webhook":
        return deps.i18n._(W.triggerWebhook)
    }
  })
  const join = deps.i18n._(W.joinToken)
  return labels.length > 0 ? labels.join(join) : deps.i18n._(W.triggerPending)
}

export function itemTargetsSession(item: { origin?: { sessionID?: string } } | undefined, sessionID: string): boolean {
  return item?.origin?.sessionID === sessionID
}
