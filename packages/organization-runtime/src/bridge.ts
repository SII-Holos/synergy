import { retrySleep } from "@ericsanchezok/synergy-util/retry"
import { openMemberConnection, type MemberConnectionClosed, type MemberConnectionOptions } from "./connection"
import { OrganizationRuntimeError } from "./error"

export function startMemberBridge(options: MemberConnectionOptions) {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const closed = run()

  async function run(): Promise<MemberConnectionClosed> {
    let failures = 0
    while (!signal.aborted) {
      let result: MemberConnectionClosed
      try {
        await using connection = await openMemberConnection({ ...options, signal })
        await options.onConnected?.(connection, signal)
        const opened = performance.now()
        result = await connection.closed
        if (performance.now() - opened >= connection.connected.offlineMs) failures = 0
      } catch (error) {
        result = {
          kind: "rejected",
          error:
            error instanceof OrganizationRuntimeError
              ? error.data
              : {
                  code: "SERVICE_UNAVAILABLE",
                  message: "Member bridge could not open its local identity",
                  retryable: false,
                  outcome: "not_dispatched",
                },
        }
      }
      if (signal.aborted) break
      if (
        result.kind !== "offline" &&
        !(
          result.kind === "rejected" &&
          result.error?.retryable &&
          (result.error.code === "RUNTIME_OFFLINE" || result.error.code === "SERVICE_UNAVAILABLE")
        )
      )
        return result
      const delay = Math.min(1_000 * 2 ** failures, 30_000) * (0.5 + Math.random() / 2)
      failures = Math.min(failures + 1, 5)
      try {
        await retrySleep(delay, signal)
      } catch {
        break
      }
    }
    return { kind: "closed" }
  }

  async function close() {
    controller.abort()
    await closed
  }
  return { closed, close, [Symbol.asyncDispose]: close }
}
