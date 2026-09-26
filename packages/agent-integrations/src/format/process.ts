import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { OwnedProcess } from "@ericsanchezok/synergy-runtime-local/process/owned-process"

export namespace FormatterProcess {
  export async function run(input: {
    command: string[]
    environment?: Record<string, string>
    signal?: AbortSignal
    beforeStart?: () => Promise<boolean>
  }) {
    if (!input.command.length) throw new Error("Formatter command is empty")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException("Formatter timed out", "TimeoutError")), 30000)
    const taskSignal = WorkspaceAccess.signal()
    const signal = AbortSignal.any([
      controller.signal,
      ...(input.signal ? [input.signal] : []),
      ...(taskSignal ? [taskSignal] : []),
    ])
    let lease: WorkspaceAccess.Lease | undefined
    let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      lease = await WorkspaceAccess.process(null, signal)
      if (input.beforeStart && !(await input.beforeStart())) return
      owned = await OwnedProcess.prepare({
        command: input.command[0]!,
        args: input.command.slice(1),
        cwd: ScopeContext.current.directory,
        env: { ...RuntimeContext.current().host.env, ...input.environment },
        lease,
        signal,
      })
      owned.child.stdout.on("data", (data: Buffer) => {
        const kept = Math.min(data.length, 65536 - bytes)
        if (kept) chunks.push(Buffer.from(data.subarray(0, kept)))
        bytes += kept
      })
      owned.child.stderr.resume()
      await owned.activate()
      owned.child.stdin.end()
      await owned.completion
      signal.throwIfAborted()
      return { exitCode: owned.child.exitCode, stdout: Buffer.concat(chunks).toString("utf8") }
    } finally {
      clearTimeout(timer)
      if (owned) await owned.stop()
      else await lease?.release()
    }
  }
}
