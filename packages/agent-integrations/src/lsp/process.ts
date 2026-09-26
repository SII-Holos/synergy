import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { OwnedProcess } from "@ericsanchezok/synergy-runtime-local/process/owned-process"
import fs from "node:fs/promises"
import path from "node:path"

export namespace LSPProcess {
  export interface Command {
    command: string
    args: string[]
    cwd: string
    env?: Record<string, string | undefined>
  }
  const context = RuntimeContext.createAsyncContext<{ signal: AbortSignal; directories: string[] }>()
  export async function resolving<T>(signal: AbortSignal, fn: () => Promise<T>) {
    const resources = { signal, directories: [] as string[] }
    let disposed: Promise<void> | undefined
    const dispose = () =>
      (disposed ??= Promise.all(
        resources.directories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
      ).then(() => {}))
    try {
      return { value: await context.run(resources, fn), dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
  export function signal() {
    const signal = context.getStore()?.signal
    if (!signal) throw new Error("Language server preparation requires a cancellation signal")
    signal.throwIfAborted()
    return signal
  }
  export function mutate<T>(fn: () => Promise<T>) {
    return WorkspaceAccess.write(null, fn, signal())
  }
  export async function temporaryDirectory() {
    const resources = context.getStore()
    if (!resources) throw new Error("Language server temporary storage requires a preparation owner")
    return mutate(async () => {
      await fs.mkdir(Global.Path.cache, { recursive: true, mode: 0o700 })
      const directory = await fs.mkdtemp(path.join(Global.Path.cache, "lsp-"))
      resources.directories.push(directory)
      await fs.chmod(directory, 0o700)
      return directory
    })
  }
  export async function start(
    command: Command,
    signal: AbortSignal,
    cooperative = true,
    cleanup?: () => Promise<void>,
  ) {
    const lease = await WorkspaceAccess.process(null, signal, { cooperative, retainAfterExit: !!cleanup })
    let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
    try {
      owned = await OwnedProcess.prepare({
        ...command,
        env: { ...RuntimeContext.current().host.env, ...command.env },
        lease: {
          ...lease,
          release: (beforeRelease) =>
            lease.release(async () => {
              await cleanup?.()
              await beforeRelease?.()
            }),
        },
        signal,
      })
      return { ...owned, claimID: lease.id }
    } catch (error) {
      if (owned) await owned.stop()
      else await lease.release(cleanup)
      throw error
    }
  }
  export async function run(input: {
    command: string[]
    cwd?: string
    env?: Record<string, string | undefined>
    check?: boolean
  }) {
    if (!input.command.length) throw new Error("Language server preparation command is empty")
    const abort = signal()
    const owned = await start(
      {
        command: input.command[0]!,
        args: input.command.slice(1),
        cwd: input.cwd ?? ScopeContext.current.directory,
        env: input.env,
      },
      abort,
      false,
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      const size = Math.min(chunk.length, 1024 * 1024 - bytes)
      if (size) chunks.push(Buffer.from(chunk.subarray(0, size)))
      bytes += size
    }
    owned.child.stdout.on("data", collect(stdout))
    owned.child.stderr.on("data", collect(stderr))
    const cancelled = Promise.withResolvers<never>()
    void cancelled.promise.catch(() => {})
    const stop = () => cancelled.reject(abort.reason)
    abort.addEventListener("abort", stop, { once: true })
    try {
      abort.throwIfAborted()
      await owned.activate()
      owned.child.stdin.end()
      await Promise.race([owned.completion, cancelled.promise])
      abort.throwIfAborted()
      const result = {
        exitCode: owned.child.exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }
      if (input.check !== false && result.exitCode !== 0)
        throw new Error(`Language server preparation exited with ${result.exitCode}: ${result.stderr.toString()}`)
      return result
    } finally {
      abort.removeEventListener("abort", stop)
      await owned.stop()
    }
  }
  export async function extractZip(archive: string, destination: string) {
    if (process.platform !== "win32") {
      await run({ command: ["unzip", "-o", "-q", archive, "-d", destination] })
      return
    }
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
    await run({
      command: [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`,
      ],
    })
  }
}
