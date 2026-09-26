import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
import * as ChannelTypes from "./channel/types"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"

const CHANNEL_CONNECT_TIMEOUT = 15_000
const STATUS_POLL_INTERVAL = 320

function getStatusText(status: ChannelTypes.Status): string {
  if (status.status === "failed") return `failed: ${status.error}`
  return status.status
}

async function resolveStatuses(input: {
  statuses: Record<string, ChannelTypes.Status>
  refresh: () => Promise<Record<string, ChannelTypes.Status>>
}): Promise<Record<string, ChannelTypes.Status>> {
  const entries = Object.entries(input.statuses)
  if (entries.length === 0) return {}

  const result: Record<string, ChannelTypes.Status> = { ...input.statuses }
  await Promise.all(
    entries.map(async ([key, status]) => {
      if (status.status === "connecting") {
        result[key] = await new Promise<ChannelTypes.Status>((resolve) => {
          const timeout = setTimeout(
            () => resolve({ status: "failed", error: "connection timeout" } as ChannelTypes.Status),
            CHANNEL_CONNECT_TIMEOUT,
          )
          const spin = setInterval(async () => {
            const current = await input.refresh().catch(() => ({}) as Record<string, ChannelTypes.Status>)
            const nextStatus = current[key]
            if (nextStatus && nextStatus.status !== "connecting") {
              clearInterval(spin)
              clearTimeout(timeout)
              resolve(nextStatus)
            }
          }, STATUS_POLL_INTERVAL)
        })
      }
    }),
  )
  return result
}

async function holosStatusRow(): Promise<RuntimeStatusRow> {
  const { HolosRuntime } = await import("./holos/runtime")
  type HolosStatus = Awaited<ReturnType<typeof HolosRuntime.status>>

  const status = await HolosRuntime.status()
  const key = "agent network"

  const getHolosStatusText = (current: HolosStatus) => {
    if (current.status === "failed") return `failed: ${current.error}`
    return current.status
  }

  if (status.status === "connecting") {
    const finalStatus = await new Promise<HolosStatus>((resolve) => {
      const timeout = setTimeout(
        () => resolve({ status: "failed", error: "connection timeout" }),
        CHANNEL_CONNECT_TIMEOUT,
      )
      const spin = setInterval(async () => {
        const nextStatus = await HolosRuntime.status().catch(
          (): HolosStatus => ({ status: "failed", error: "status unavailable" }),
        )
        if (nextStatus.status !== "connecting") {
          clearInterval(spin)
          clearTimeout(timeout)
          resolve(nextStatus)
        }
      }, STATUS_POLL_INTERVAL)
    })
    return { label: "Holos", value: `${key} ${getHolosStatusText(finalStatus)}`, kind: statusKind(finalStatus.status) }
  }

  return { label: "Holos", value: `${key} ${getHolosStatusText(status)}`, kind: statusKind(status.status) }
}

export async function connectionStatusRows(report: (rows: RuntimeStatusRow[]) => void): Promise<RuntimeStatusRow[]> {
  const { Bus } = await import("@ericsanchezok/synergy-harness/bus")
  const { Channel } = await import("./channel")

  const channelStatuses = await resolveStatuses({ statuses: await Channel.status(), refresh: () => Channel.status() })
  const rows: RuntimeStatusRow[] = [channelStatusRow(channelStatuses), await holosStatusRow()]

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
