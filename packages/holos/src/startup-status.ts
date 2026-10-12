import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
const CHANNEL_CONNECT_TIMEOUT = 15000
const STATUS_POLL_INTERVAL = 320
async function holosStatusRow(): Promise<RuntimeStatusRow> {
  const { HolosRuntime } = await import("@ericsanchezok/synergy-holos/holos/runtime")
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

function statusKind(status: string): RuntimeStatusRow["kind"] {
  return status === "connected"
    ? "success"
    : status === "connecting"
      ? "pending"
      : status === "failed"
        ? "error"
        : "muted"
}
export async function connectionStatusRows() {
  return [await holosStatusRow()]
}
