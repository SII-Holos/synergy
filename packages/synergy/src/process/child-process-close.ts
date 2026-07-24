import type { ChildProcess } from "node:child_process"

export namespace ChildProcessClose {
  export const DEFAULT_DRAIN_GRACE_MS = 1_000

  export type Result = {
    code: number | null
    signal: NodeJS.Signals | null
    drainTimedOut: boolean
  }

  export function wait(
    child: ChildProcess,
    options: {
      drainGraceMs?: number
      onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
    } = {},
  ): Promise<Result> {
    const drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS
    return new Promise<Result>((resolve, reject) => {
      let settled = false
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      let exit: Pick<Result, "code" | "signal"> | undefined

      const cleanup = () => {
        if (drainTimer) clearTimeout(drainTimer)
        child.off("error", onError)
        child.off("exit", onExit)
        child.off("close", onClose)
      }
      const finish = (result: Result) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const streamsClosed = () =>
        [child.stdout, child.stderr].every((stream) => !stream || stream.closed || stream.destroyed)
      const onError = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exit || settled) return
        exit = { code, signal }
        options.onExit?.(code, signal)
        if (streamsClosed()) {
          finish({ ...exit, drainTimedOut: false })
          return
        }
        drainTimer = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish({ ...exit!, drainTimedOut: true })
        }, drainGraceMs)
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        finish({
          code: code ?? exit?.code ?? null,
          signal: signal ?? exit?.signal ?? null,
          drainTimedOut: false,
        })
      }

      child.once("error", onError)
      child.once("exit", onExit)
      child.once("close", onClose)

      if (child.exitCode !== null || child.signalCode !== null) {
        onExit(child.exitCode, child.signalCode)
        if (streamsClosed()) onClose(child.exitCode, child.signalCode)
      }
    })
  }
}
