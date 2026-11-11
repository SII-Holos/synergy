import { retrySleep } from "@ericsanchezok/synergy-util/retry"
import { openMemberConnection, type MemberConnectionClosed, type MemberConnectionOptions } from "./connection"
import { OrganizationRuntimeError } from "./error"

export function startMemberBridge(options: MemberConnectionOptions) {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let cleanupFailure: { error: unknown } | undefined
  const closed = run()

  async function run(): Promise<MemberConnectionClosed> {
    let failures = 0
    while (!signal.aborted) {
      let result: MemberConnectionClosed
      let stage: "opening" | "cleanup" = "opening"
      try {
        const attempt = new AbortController()
        const connectionSignal = AbortSignal.any([signal, attempt.signal])
        const connection = await openMemberConnection({ ...options, signal })
        const abort = () => attempt.abort(connection.signal.reason)
        connection.signal.addEventListener("abort", abort, { once: true })
        if (connection.signal.aborted) abort()
        let cleanup: void | (() => void | Promise<void>) = undefined
        try {
          cleanup = await options.onConnected?.(connection, connectionSignal)
          const opened = performance.now()
          result = await connection.closed
          if (performance.now() - opened >= connection.connected.offlineMs) failures = 0
        } finally {
          stage = "cleanup"
          attempt.abort()
          connection.signal.removeEventListener("abort", abort)
          try {
            await cleanup?.()
          } finally {
            await connection.close()
          }
        }
      } catch (error) {
        if (stage === "cleanup") cleanupFailure = { error }
        result = {
          kind: "rejected",
          error:
            error instanceof OrganizationRuntimeError
              ? error.data
              : {
                  code: "SERVICE_UNAVAILABLE",
                  message:
                    stage === "cleanup"
                      ? "Member bridge could not drain its connection owners"
                      : "Member bridge could not open its local identity",
                  retryable: false,
                  outcome: stage === "cleanup" ? "unknown" : "not_dispatched",
                },
        }
      }
      if (signal.aborted) {
        if (cleanupFailure) return result
        break
      }
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
    if (cleanupFailure) throw cleanupFailure.error
  }
  return { closed, close, [Symbol.asyncDispose]: close }
}
