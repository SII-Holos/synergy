import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { randomUUID } from "node:crypto"

export namespace FormatterProcess {
  export async function run(input: {
    command: string[]
    environment?: Record<string, string>
    signal?: AbortSignal
    expectedFile?: { path: string; canonical: string; version: string | null }
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
    let resources: EnvironmentResources.Resolved | undefined
    let owned: Awaited<ReturnType<typeof EnvironmentProcess.prepare>> | undefined
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      const selected = EnvironmentResources.current()
      const scopeID = ScopeContext.current.scope.id
      const workspaceID = selected?.workspace?.id ?? ScopeContext.tryWorkspace()?.id
      const environmentID = selected?.environment?.id ?? selected?.selection?.environmentID
      resources = await (environmentID ? EnvironmentResources.resolve : EnvironmentResources.select)({
        scopeID,
        ownerID: `formatter:${workspaceID ?? scopeID}`,
        workspaceID,
        environmentID,
        needs: { execution: "exec" },
        signal,
      })
      owned = await EnvironmentProcess.prepare({
        id: `format:${randomUUID()}`,
        scopeID,
        resources,
        signal,
        command: {
          command: input.command[0]!,
          args: input.command.slice(1),
          cwd: resources.directory!,
          env: { ...resources.runtime!.env, ...input.environment },
          writableRoots: null,
          preconditions: input.expectedFile ? [input.expectedFile] : undefined,
        },
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
    } catch (error) {
      if (error instanceof EnvironmentProcess.Error && error.data.failure?.name === "WorkspaceFileWriteConflictError")
        return
      throw error
    } finally {
      clearTimeout(timer)
      try {
        if (owned) await owned.stop().catch(() => {})
      } finally {
        await resources?.release()
      }
    }
  }
}
