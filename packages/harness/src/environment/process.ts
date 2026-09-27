import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import type { ProcessHandle } from "../process/handle"
import { WorkspaceMounts } from "../workspace/mount"
import { Environment } from "."
import { EnvironmentExecution } from "./execution"
import { ExecutionProtocol } from "./executor"
import type { EnvironmentResources } from "./resources"

export namespace EnvironmentProcess {
  export const Error = NamedError.create(
    "EnvironmentProcessError",
    z.object({ id: z.string(), environmentID: z.string(), stage: z.string(), message: z.string() }),
  )
  export interface Input {
    id: string
    scopeID: string
    resources: EnvironmentResources.Resolved
    command: ExecutionProtocol.Command
    signal?: AbortSignal
  }

  class Child extends EventEmitter implements ProcessHandle {
    pid?: number
    readonly stdout = new PassThrough({ highWaterMark: 65_536 })
    readonly stderr = new PassThrough({ highWaterMark: 65_536 })
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    constructor(
      readonly stdin: Writable,
      readonly stop: () => Promise<void>,
      readonly alive: () => boolean | undefined,
      readonly completion: Promise<void>,
    ) {
      super()
    }
    kill() {
      if (this.alive() === false) return false
      void this.stop().catch((error) => this.emit("error", error))
      return true
    }
  }

  export async function prepare(input: Input) {
    input.signal?.throwIfAborted()
    const environment = input.resources.environment
    if (!environment || !input.resources.runtime)
      throw new Environment.Unavailable({ environmentID: "", message: "Process requires resolved execution resources" })
    const command = ExecutionProtocol.Command.parse(input.command)
    const mount = input.resources.workspace?.activeMount
    if (mount && command.writableRoots?.length && !command.writableRoots.includes(mount.path))
      command.writableRoots = [...command.writableRoots, mount.path]
    const workspaces = input.resources.workspace ? [WorkspaceMounts.reference(input.resources.workspace)] : undefined
    const completed = Promise.withResolvers<void>()
    const running = Promise.withResolvers<boolean>()
    void completed.promise.catch(() => {})
    void running.promise.catch(() => {})
    let activation: Promise<void> | undefined
    let submission: Promise<EnvironmentExecution.Info> | undefined
    let stopping: Promise<void> | undefined
    let finished = false
    let physicalExit = false
    let active = false
    let stage = "admission"
    let cursor = 0
    const stdin = new Writable({
      highWaterMark: 65_536,
      write(chunk: Buffer, _encoding, callback) {
        void send(Buffer.from(chunk)).then(() => callback(), callback)
      },
      final(callback) {
        void send(new Uint8Array(), true).then(() => callback(), callback)
      },
    })
    const child = new Child(
      stdin,
      stop,
      () => (finished || physicalExit ? false : active ? true : undefined),
      completed.promise,
    )
    child.on("error", () => {})
    stdin.on("error", () => {})
    child.stdout.on("error", () => {})
    child.stderr.on("error", () => {})
    async function send(bytes: Uint8Array, end = false) {
      if (!(await running.promise) || physicalExit || finished) return
      for (let offset = 0; offset < bytes.length; offset += 65_536)
        await EnvironmentExecution.stdin(input.id, input.scopeID, bytes.subarray(offset, offset + 65_536))
      if (end) await EnvironmentExecution.stdin(input.id, input.scopeID, new Uint8Array(), true)
    }
    function fail(reason: unknown) {
      if (finished) return
      const error = new Error({
        id: input.id,
        environmentID: environment!.id,
        stage,
        message: reason instanceof globalThis.Error ? reason.message : String(reason),
      })
      finished = true
      input.signal?.removeEventListener("abort", abort)
      running.reject(error)
      stdin.destroy(error)
      child.stdout.end()
      child.stderr.end()
      child.emit("error", error)
      child.emit("close", child.exitCode, child.signalCode)
      completed.reject(error)
    }
    async function stream() {
      stage = "execution"
      while (!finished) {
        const info = await EnvironmentExecution.reconcile(input.id, input.scopeID)
        if (!child.pid) {
          child.pid = input.resources.executor?.localPID?.(input.id)
          if (child.pid) child.emit("spawn")
        }
        if (info.state === "unknown")
          throw new globalThis.Error("Execution outcome is unknown; inspect the existing operation before continuing")
        if (info.status?.state === "running") {
          active = true
          running.resolve(true)
        }
        const terminal = info.status && ExecutionProtocol.terminal(info.status)
        if (terminal && !physicalExit) {
          physicalExit = true
          child.exitCode = info.status!.exitCode ?? null
          child.signalCode = (info.status!.signal as NodeJS.Signals | null) ?? null
          running.resolve(false)
          child.emit("exit", child.exitCode, child.signalCode)
        }
        for (const chunk of await EnvironmentExecution.output(input.id, input.scopeID, cursor)) {
          if (chunk.cursor !== cursor + 1) throw new globalThis.Error("Execution output cursor is discontinuous")
          const target = chunk.stream === "stdout" ? child.stdout : child.stderr
          if (!target.destroyed && !target.write(Buffer.from(chunk.data, "base64")))
            await new Promise<void>((resolve) => {
              const done = () => {
                target.off("drain", done)
                target.off("close", done)
                resolve()
              }
              target.once("drain", done)
              target.once("close", done)
            })
          cursor = chunk.cursor
        }
        if (terminal && cursor >= info.status!.cursor) {
          stage = "saving"
          await EnvironmentExecution.complete(input.id, input.scopeID)
          if (info.status!.error) throw new globalThis.Error(info.status!.error)
          finished = true
          input.signal?.removeEventListener("abort", abort)
          stdin.destroy()
          child.stdout.end()
          child.stderr.end()
          child.emit("close", child.exitCode, child.signalCode)
          completed.resolve()
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      }
    }
    function activate() {
      if (finished) return completed.promise
      return (activation ??= (async () => {
        try {
          submission = EnvironmentExecution.start({
            id: input.id,
            scopeID: input.scopeID,
            environmentID: environment!.id,
            command,
            workspaces,
            signal: input.signal,
          })
          await submission
          void stream().catch(fail)
          if (!(await running.promise)) {
            const info = await EnvironmentExecution.get(input.id, input.scopeID)
            if (info.status?.error) await completed.promise
            if (info.status?.state === "cancelled" && info.status.effectsStarted === false)
              throw input.signal?.reason ?? new globalThis.Error("Execution cancelled before activation")
          }
        } catch (error) {
          fail(error)
          throw error
        }
      })())
    }
    function stop() {
      return (stopping ??= (async () => {
        child.stdout.resume()
        child.stderr.resume()
        if (!activation) {
          finished = true
          running.resolve(false)
          input.signal?.removeEventListener("abort", abort)
          stdin.destroy()
          child.stdout.end()
          child.stderr.end()
          child.signalCode = "SIGTERM"
          child.emit("close", null, "SIGTERM")
          completed.resolve()
          return
        }
        await submission
        await EnvironmentExecution.cancel(input.id, input.scopeID)
        await completed.promise
      })())
    }
    function abort() {
      void stop().catch(fail)
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    return {
      child,
      activate,
      stop,
      completion: completed.promise,
      executionID: input.id,
      detachSignal() {
        input.signal?.removeEventListener("abort", abort)
      },
      async resize(cols: number, rows: number) {
        if (!command.pty || !(await running.promise) || finished) throw new globalThis.Error("PTY is not running")
        await EnvironmentExecution.resize(input.id, input.scopeID, cols, rows)
      },
    }
  }
}
