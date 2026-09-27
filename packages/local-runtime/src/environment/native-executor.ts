import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { ProcessEnvironment } from "../process/environment"
import type { Readable } from "node:stream"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { EnvironmentSchema } from "@ericsanchezok/synergy-harness/environment/schema"
import { ExecutionProtocol, type Executor } from "@ericsanchezok/synergy-harness/environment/executor"
import type { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCoordinator } from "../workspace/coordinator"
import { OwnedProcess } from "../process/owned-process"
import { NativePty } from "../process/native-pty"
import { NativeWorkspaceFiles } from "../workspace/file-host"
import type { SandboxHost } from "@ericsanchezok/synergy-harness/sandbox/host"
import type { SandboxExecutionWrapper } from "@ericsanchezok/synergy-harness/sandbox/types"

const Receipt = z.object({
  status: ExecutionProtocol.Status,
  released: z.boolean(),
  claim: z.object({ id: z.string(), token: z.string() }).optional(),
})
interface NativeExecutorOptions {
  target: EnvironmentSchema.Target
  directory: string
  coordinator: WorkspaceCoordinator
  acquire?: (command: ExecutionProtocol.Command, signal: AbortSignal) => Promise<WorkspaceAccess.Lease>
  maxOutputBytes?: number
  runAs?: { uid: number; gid: number }
  files?: { materializationRoot: string; allowedRoots?: string[] }
  runtime?: Pick<ExecutionProtocol.Description, "shell" | "directory" | "env">
  sandbox?: SandboxHost.Host
}
type Operation = {
  status: ExecutionProtocol.Status
  abort: AbortController
  cancelled: boolean
  released: boolean
  lease?: WorkspaceAccess.Lease
  owned?: Awaited<ReturnType<typeof OwnedProcess.prepare>>
  finished?: Promise<void>
  writes: Promise<void>
  bytes: number
}

export class NativeExecutor implements Executor {
  readonly files: NativeWorkspaceFiles
  private readonly operations = new Map<string, Operation>()
  private readonly starting = new Map<string, Promise<ExecutionProtocol.Status>>()
  private readonly stopped = Promise.withResolvers<void>()
  private lock?: Promise<void>
  private closing?: Promise<void>
  private accepting = true
  private readonly description: ExecutionProtocol.Description
  private readonly sandboxes = new Map<string, SandboxExecutionWrapper>()

  private constructor(private readonly options: NativeExecutorOptions) {
    this.description = ExecutionProtocol.Description.parse({
      target: options.target,
      platform: process.platform,
      arch: process.arch,
      shell: options.runtime?.shell ?? (process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh"),
      directory: options.runtime?.directory ?? path.join(options.directory, "work"),
      env: ProcessEnvironment.select(options.runtime?.env ?? process.env),
    })
    this.files = new NativeWorkspaceFiles({
      directory: path.join(options.directory, "workspace"),
      materializationRoot: options.files?.materializationRoot ?? path.join(options.directory, "views"),
      allowedRoots: options.files?.allowedRoots,
      coordinator: options.coordinator,
      owner: options.runAs,
      executionWriter: async (id, root) => {
        const status = await this.required(id)
        const receipt = await this.read(id)
        if (!ExecutionProtocol.terminal(status) || !receipt?.claim || receipt.released)
          throw new Error("Execution has no retained completed writer")
        await options.coordinator.validateRetention(receipt.claim, root)
      },
    })
  }

  static async open(options: NativeExecutorOptions) {
    const executor = new NativeExecutor(options)
    const ready = Promise.withResolvers<void>()
    executor.lock = withFileLock({ directory: options.directory, key: "executor", timeoutMs: 1000 }, async () => {
      ready.resolve()
      await executor.stopped.promise
    })
    void executor.lock.catch(ready.reject)
    try {
      await ready.promise
      await fs.mkdir(executor.description.directory, { recursive: true, mode: 0o700 })
      return executor
    } catch (error) {
      executor.stopped.resolve()
      await executor.lock.catch(() => {})
      throw error
    }
  }

  async describe() {
    if (!this.accepting) throw new Error("Executor is closing")
    return structuredClone(this.description)
  }

  localPID(id: string) {
    return this.operations.get(id)?.owned?.child.pid
  }

  async prepareSandbox(raw: ExecutionProtocol.SandboxInput) {
    if (!this.accepting) throw new Error("Executor is closing")
    const input = ExecutionProtocol.SandboxInput.parse(raw)
    const id = randomUUID()
    if (!this.options.sandbox)
      return {
        id,
        command: input.command,
        args: input.args,
        sandboxed: false,
        skipReason: "Target sandbox is unavailable",
      }
    const wrapper = this.options.sandbox.prepareWrapper(input)
    this.sandboxes.set(id, wrapper)
    return ExecutionProtocol.Sandbox.parse({ ...wrapper, id })
  }

  async releaseSandbox(id: string) {
    const wrapper = this.sandboxes.get(id)
    if (!wrapper) return
    this.options.sandbox?.cleanupWrapper(wrapper)
    this.sandboxes.delete(id)
  }

  async start(raw: ExecutionProtocol.Request): Promise<ExecutionProtocol.Status> {
    if (!this.accepting) throw new Error("Executor is closing")
    const request = ExecutionProtocol.Request.parse(raw)
    this.assertTarget(request.target)
    if (ExecutionProtocol.digest(request.command) !== request.digest)
      throw new Error("Execution input digest does not match")
    const pending = this.starting.get(request.id)
    if (pending) {
      const result = await pending
      this.assertDigest(result, request.digest)
      return result
    }
    const start = this.prepare(request)
    this.starting.set(request.id, start)
    try {
      return await start
    } finally {
      this.starting.delete(request.id)
    }
  }

  private async prepare(request: ExecutionProtocol.Request) {
    const existing = await this.status(request.id)
    if (existing) {
      this.assertDigest(existing, request.digest)
      return existing
    }
    const operation: Operation = {
      status: ExecutionProtocol.Status.parse({
        id: request.id,
        target: this.options.target,
        digest: request.digest,
        state: "accepted",
        effectsStarted: false,
        cursor: 0,
      }),
      abort: new AbortController(),
      cancelled: false,
      released: false,
      writes: Promise.resolve(),
      bytes: 0,
    }
    this.operations.set(request.id, operation)
    await this.persist(operation)
    operation.finished = this.launch(request.command, operation)
    void operation.finished.catch(() => {})
    return structuredClone(operation.status)
  }

  private async launch(command: ExecutionProtocol.Command, operation: Operation) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      operation.lease = this.options.acquire
        ? await this.options.acquire(command, operation.abort.signal)
        : await this.options.coordinator.acquire({
            id: JSON.stringify([this.options.target, operation.status.id]),
            owner: this.options.target.environmentID,
            ancestors: [],
            kind: "process",
            roots: command.writableRoots,
            retainAfterExit: true,
            durable: true,
            signal: operation.abort.signal,
          })
      operation.abort.signal.throwIfAborted()
      const lease = operation.lease
      if (!lease.recovery) throw new Error("Executor requires a durable Workspace claim")
      await this.persist(operation)
      operation.owned = await OwnedProcess.prepare({
        command: this.options.runAs ? "/usr/bin/setpriv" : command.command,
        args: this.options.runAs
          ? [
              `--reuid=${this.options.runAs.uid}`,
              `--regid=${this.options.runAs.gid}`,
              "--clear-groups",
              "--",
              command.command,
              ...command.args,
            ]
          : command.args,
        cwd: command.cwd,
        env: command.env,
        signal: operation.abort.signal,
        pty: command.pty ? { ...command.pty, library: NativePty.libraryPath() } : undefined,
        lease: {
          id: lease.id,
          bindProcess: (pid, options) => lease.bindProcess(pid, options),
          release: () => this.options.coordinator.confirmDrained(lease.recovery!),
        },
      })
      const owned = operation.owned
      const streams = Promise.all([
        this.capture(operation, "stdout", owned.child.stdout),
        this.capture(operation, "stderr", owned.child.stderr),
      ])
      void streams.catch(() => owned.stop())
      operation.status.effectsStarted = true
      await this.persist(operation)
      await owned.activate()
      operation.status.state = "running"
      await this.persist(operation)
      if (command.timeoutMs)
        timer = setTimeout(() => {
          operation.cancelled = true
          void owned.stop().catch(() => {})
        }, command.timeoutMs)
      await owned.completion
      await streams
      operation.status = {
        ...operation.status,
        state: operation.cancelled ? "cancelled" : "exited",
        exitCode: owned.child.exitCode,
        signal: owned.child.signalCode,
        treeDrained: true,
        streamsDrained: true,
      }
    } catch (error) {
      if (operation.status.effectsStarted === false) {
        await operation.owned?.stop()
        await operation.lease?.release()
        operation.released = true
        operation.status = {
          ...operation.status,
          state: operation.cancelled ? "cancelled" : "exited",
          exitCode: operation.cancelled ? null : 1,
          error: operation.cancelled ? undefined : error instanceof Error ? error.message : String(error),
          treeDrained: true,
          streamsDrained: true,
        }
      } else {
        await operation.owned?.stop().catch(() => {})
        operation.status = {
          ...operation.status,
          state: "unknown",
          error: error instanceof Error ? error.message : String(error),
        }
      }
    } finally {
      clearTimeout(timer)
      await this.persist(operation)
    }
  }

  private async capture(operation: Operation, stream: "stdout" | "stderr", source: Readable) {
    for await (const raw of source) {
      const data = Buffer.from(raw)
      for (let start = 0; start < data.length; start += 65_536) {
        const remaining = Math.max(0, (this.options.maxOutputBytes ?? 256 * 1024 * 1024) - operation.bytes)
        const bytes = data.subarray(start, Math.min(start + 65_536, start + remaining))
        if (bytes.length < Math.min(65_536, data.length - start)) operation.status.outputTruncated = true
        if (!bytes.length) continue
        operation.bytes += bytes.length
        const chunk = { cursor: ++operation.status.cursor, stream, data: bytes.toString("base64") }
        const write = operation.writes.then(() =>
          AtomicFile.writeJsonAtomic(this.filename(operation.status.id, String(chunk.cursor)), JSON.stringify(chunk), {
            private: true,
            durable: true,
          }),
        )
        operation.writes = write
        await write
      }
    }
  }

  async status(id: string): Promise<ExecutionProtocol.Status | undefined> {
    ExecutionProtocol.ID.parse(id)
    const operation = this.operations.get(id)
    if (operation) return structuredClone(operation.status)
    const receipt = await this.read(id)
    if (!receipt) return
    this.assertTarget(receipt.status.target)
    if (!ExecutionProtocol.terminal(receipt.status))
      return { ...receipt.status, state: "unknown", treeDrained: false, streamsDrained: false }
    return receipt.status
  }

  async output(id: string, after: number, limit: number) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error("Invalid output cursor or limit")
    const status = await this.required(id)
    await this.operations.get(id)?.writes
    const result: ExecutionProtocol.Chunk[] = []
    for (let cursor = after + 1; cursor <= Math.min(status.cursor, after + limit); cursor++)
      result.push(ExecutionProtocol.Chunk.parse(await Bun.file(this.filename(id, String(cursor))).json()))
    return result
  }

  async stdin(id: string, data: Uint8Array, end = false) {
    if (data.byteLength > 65_536) throw new Error("Input frame exceeds 64 KiB")
    const operation = this.running(id)
    await new Promise<void>((resolve, reject) =>
      operation.owned!.child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
    )
    if (end) operation.owned!.child.stdin.end()
  }

  async resize(id: string, cols: number, rows: number) {
    const size = ExecutionProtocol.Command.shape.pty.unwrap().parse({ cols, rows })
    this.running(id).owned!.resize(size.cols, size.rows)
  }

  async cancel(id: string, digest: string) {
    ExecutionProtocol.ID.parse(id)
    await this.starting.get(id)
    const operation = this.operations.get(id)
    if (!operation) {
      const previous = await this.status(id)
      if (previous) {
        this.assertDigest(previous, digest)
        if (!ExecutionProtocol.terminal(previous))
          throw new Error("Executor cannot confirm termination of the recovered operation")
        return
      }
      await AtomicFile.writeJsonAtomic(
        this.filename(id),
        JSON.stringify({
          status: ExecutionProtocol.Status.parse({
            id,
            target: this.options.target,
            digest,
            state: "cancelled",
            effectsStarted: false,
            cursor: 0,
            treeDrained: true,
            streamsDrained: true,
          }),
          released: true,
        }),
        { private: true, durable: true },
      )
      return
    }
    this.assertDigest(operation.status, digest)
    operation.cancelled = true
    operation.abort.abort(new Error("Execution cancelled"))
    await operation.owned?.stop()
    await operation.finished
  }

  async release(id: string) {
    const status = await this.required(id)
    if (!ExecutionProtocol.terminal(status)) throw new Error("Cannot release an execution without physical completion")
    const operation = this.operations.get(id)
    if (operation) {
      await operation.lease?.release()
      operation.released = true
      await this.persist(operation)
      return
    }
    const receipt = await this.read(id)
    if (!receipt || receipt.released) return
    if (receipt.claim) await (await this.options.coordinator.recover(receipt.claim)).release()
    await AtomicFile.writeJsonAtomic(this.filename(id), JSON.stringify({ ...receipt, released: true }), {
      private: true,
      durable: true,
    })
  }

  async close() {
    this.accepting = false
    return (this.closing ??= (async () => {
      const files = this.files.close()
      await Promise.allSettled(this.starting.values())
      const results = await Promise.allSettled(
        [...this.operations.values()].map((operation) => this.cancel(operation.status.id, operation.status.digest)),
      )
      this.stopped.resolve()
      await files
      for (const id of this.sandboxes.keys()) await this.releaseSandbox(id)
      await this.lock
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })())
  }

  [Symbol.asyncDispose]() {
    return this.close()
  }

  private async persist(operation: Operation) {
    const write = operation.writes.then(() =>
      AtomicFile.writeJsonAtomic(
        this.filename(operation.status.id),
        JSON.stringify({ status: operation.status, released: operation.released, claim: operation.lease?.recovery }),
        { private: true, durable: true },
      ),
    )
    operation.writes = write
    await write
  }

  private async read(id: string) {
    const file = Bun.file(this.filename(id))
    if (!(await file.exists())) return
    return Receipt.parse(await file.json())
  }

  private filename(id: string, chunk?: string) {
    ExecutionProtocol.ID.parse(id)
    const key = createHash("sha256").update(id).digest("hex")
    return path.join(this.options.directory, key, chunk ? `${chunk}.json` : "receipt.json")
  }

  private assertTarget(target: EnvironmentSchema.Target) {
    if (!EnvironmentSchema.sameTarget(target, this.options.target))
      throw new Error("Execution belongs to another allocation")
  }

  private assertDigest(status: ExecutionProtocol.Status, digest: string) {
    if (status.digest !== digest) throw new Error("Operation ID already has different input")
  }

  private async required(id: string) {
    const status = await this.status(id)
    if (!status) throw new Error("Execution not found")
    return status
  }

  private running(id: string) {
    const operation = this.operations.get(id)
    if (!operation?.owned || operation.status.state !== "running") throw new Error("Execution is not running")
    return operation
  }
}
