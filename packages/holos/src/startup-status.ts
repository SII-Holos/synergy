import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
const CHANNEL_CONNECT_TIMEOUT = 15000
const STATUS_POLL_INTERVAL = 320
const polling = RuntimeContext.state(() => new AbortController())

export function stopStatusPolling() {
  polling().abort()
}

async function holosStatusRow(): Promise<RuntimeStatusRow | undefined> {
  const signal = polling().signal
  const { HolosRuntime } = await import("@ericsanchezok/synergy-holos/holos/runtime")
  type HolosStatus = Awaited<ReturnType<typeof HolosRuntime.status>>

  if (signal.aborted) return
  const status = await HolosRuntime.status()
  if (signal.aborted) return
  const key = "agent network"

  const getHolosStatusText = (current: HolosStatus) => {
    if (current.status === "failed") return `failed: ${current.error}`
    return current.status
  }

  if (status.status === "connecting") {
    const finalStatus = await new Promise<HolosStatus | undefined>((resolve) => {
      const finish = (value?: HolosStatus) => {
        clearInterval(spin)
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        resolve(value)
      }
      const abort = () => finish()
      const timeout = setTimeout(
        () => finish({ status: "failed", error: "connection timeout" }),
        CHANNEL_CONNECT_TIMEOUT,
      )
      const spin = setInterval(async () => {
        const nextStatus = await HolosRuntime.status().catch(
          (): HolosStatus => ({
            status: "failed",
            error: "status unavailable",
          }),
        )
        if (nextStatus.status !== "connecting") {
          finish(nextStatus)
        }
      }, STATUS_POLL_INTERVAL)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
    if (!finalStatus || signal.aborted) return
    return { label: "Holos", value: `${key} ${getHolosStatusText(finalStatus)}`, kind: statusKind(finalStatus.status) }
  }

  return { label: "Holos", value: `${key} ${getHolosStatusText(status)}`, kind: statusKind(status.status) }
}

function statusKind(status: string): RuntimeStatusRow["kind"] {
  return status === "connected"
    ? "success"
    : status === "connecting"
      ? "pending"
      : status === "failed"
        ? "error"
        : "muted"
}
export async function connectionStatusRows(): Promise<RuntimeStatusRow[]> {
  const row = await holosStatusRow()
  return row ? [row] : []
}
