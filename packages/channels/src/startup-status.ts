import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
import * as ChannelTypes from "@ericsanchezok/synergy-channels/channel/types"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

const CHANNEL_CONNECT_TIMEOUT = 15_000
const STATUS_POLL_INTERVAL = 320
const polling = RuntimeContext.state(() => new AbortController())

export function stopStatusPolling() {
  polling().abort()
}

function getStatusText(status: ChannelTypes.Status): string {
  if (status.status === "failed") return `failed: ${status.error}`
  return status.status
}

async function resolveStatuses(input: {
  statuses: Record<string, ChannelTypes.Status>
  refresh: () => Promise<Record<string, ChannelTypes.Status>>
  signal: AbortSignal
}): Promise<Record<string, ChannelTypes.Status>> {
  const entries = Object.entries(input.statuses)
  if (entries.length === 0) return {}

  const result: Record<string, ChannelTypes.Status> = { ...input.statuses }
  await Promise.all(
    entries.map(async ([key, status]) => {
      if (status.status === "connecting") {
        const next = await new Promise<ChannelTypes.Status | undefined>((resolve) => {
          const finish = (value?: ChannelTypes.Status) => {
            clearInterval(spin)
            clearTimeout(timeout)
            input.signal.removeEventListener("abort", abort)
            resolve(value)
          }
          const abort = () => finish()
          const timeout = setTimeout(
            () => finish({ status: "failed", error: "connection timeout" }),
            CHANNEL_CONNECT_TIMEOUT,
          )
          const spin = setInterval(async () => {
            const current = await input.refresh().catch(() => ({}) as Record<string, ChannelTypes.Status>)
            const nextStatus = current[key]
            if (nextStatus && nextStatus.status !== "connecting") {
              finish(nextStatus)
            }
          }, STATUS_POLL_INTERVAL)
          input.signal.addEventListener("abort", abort, { once: true })
          if (input.signal.aborted) abort()
        })
        if (next) result[key] = next
      }
    }),
  )
  return result
}

export async function connectionStatusRows(report: (rows: RuntimeStatusRow[]) => void): Promise<RuntimeStatusRow[]> {
  const signal = polling().signal
  const { Bus } = await import("@ericsanchezok/synergy-harness/bus")
  const { Channel } = await import("@ericsanchezok/synergy-channels/channel")

  if (signal.aborted) return []
  const channelStatuses = await resolveStatuses({
    statuses: await Channel.status(),
    refresh: () => Channel.status(),
    signal,
  })
  if (signal.aborted) return []
  const rows: RuntimeStatusRow[] = [channelStatusRow(channelStatuses)]

  const channelState = ScopedState.create(
    () => {
      const unsubs: Array<() => void> = []
      unsubs.push(
        Bus.subscribe(Channel.Event.Connected, (event) => {
          const channel = event.properties.channelType + ":" + event.properties.accountId
          report([{ label: "Channels", value: `${channel} reconnected`, kind: "success" }])
        }),
      )
      unsubs.push(
        Bus.subscribe(Channel.Event.Disconnected, (event) => {
          const channel = event.properties.channelType + ":" + event.properties.accountId
          const reason = event.properties.reason ? ": " + event.properties.reason : ""
          report([{ label: "Channels", value: `${channel} disconnected${reason}`, kind: "warning" }])
        }),
      )
      return { unsubs }
    },
    async (s) => {
      for (const unsub of s.unsubs) unsub()
    },
  )
  void channelState()
  return rows
}

function channelStatusRow(statuses: Record<string, ChannelTypes.Status>): RuntimeStatusRow {
  const entries = Object.entries(statuses)
  if (entries.length === 0) return { label: "Channels", value: "none configured", kind: "muted" }
  const failed = entries.filter(([, status]) => status.status === "failed")
  if (failed.length > 0) {
    return {
      label: "Channels",
      value: failed.map(([key, status]) => `${key} ${getStatusText(status)}`).join(", "),
      kind: "error",
    }
  }
  const connected = entries.filter(([, status]) => status.status === "connected")
  if (connected.length === entries.length) {
    return { label: "Channels", value: connected.map(([key]) => `${key} connected`).join(", "), kind: "success" }
  }
  return {
    label: "Channels",
    value: entries.map(([key, status]) => `${key} ${getStatusText(status)}`).join(", "),
    kind: entries.some(([, status]) => status.status === "connecting") ? "pending" : "muted",
  }
}

function statusKind(status: ChannelTypes.Status["status"]): RuntimeStatusRow["kind"] {
  if (status === "connected") return "success"
  if (status === "connecting") return "pending"
  if (status === "failed") return "error"
  return "muted"
}
