import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { OwnedProcess } from "../process/owned-process"

export namespace WorktreeProcess {
  export function run(input: Input) {
    return WorkspaceAccess.withinTask(() => execute(input))
  }

  interface Input {
    command: string[] | (() => Promise<string[]>)
    directory: string
    roots: string[] | null
    env?: Record<string, string | undefined>
    metadata?: boolean
    signal?: AbortSignal
    beforeStart?: () => Promise<boolean>
  }

  async function execute(input: Input) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException("Worktree command timed out", "TimeoutError")),
      300_000,
    )
    const taskSignal = WorkspaceAccess.signal()
    const signal = AbortSignal.any([
      controller.signal,
      ...(taskSignal ? [taskSignal] : []),
      ...(input.signal ? [input.signal] : []),
    ])
    let lease: WorkspaceAccess.Lease | undefined
    let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let overflow = false
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      const size = Math.min(chunk.length, 1024 * 1024 - bytes)
      if (size) chunks.push(Buffer.from(chunk.subarray(0, size)))
      bytes += size
      if (size < chunk.length) overflow = true
    }
    try {
      const acquire = () => WorkspaceAccess.process(input.roots, signal, { transient: input.metadata })
      lease = input.metadata ? await WorkspaceAccess.observeWrites(undefined, acquire) : await acquire()
      if (input.beforeStart && !(await input.beforeStart()))
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), skipped: true }
      const command = typeof input.command === "function" ? await input.command() : input.command
      if (!command.length) throw new Error("Worktree command is empty")
      owned = await OwnedProcess.prepare({
        command: command[0]!,
        args: command.slice(1),
        cwd: input.directory,
        env: { ...RuntimeContext.current().host.env, ...input.env },
        lease,
        signal,
      })
      owned.child.stdout.on("data", collect(stdout))
      owned.child.stderr.on("data", collect(stderr))
      await owned.activate()
      owned.child.stdin.end()
      await owned.completion
      signal.throwIfAborted()
      if (overflow) throw new Error("Worktree command output exceeded 1 MiB")
      return { exitCode: owned.child.exitCode ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
    } finally {
      clearTimeout(timer)
      if (owned) await owned.stop()
      else await lease?.release()
    }
  }
}
