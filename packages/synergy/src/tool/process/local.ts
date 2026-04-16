import { ProcessRegistry } from "../../process/registry"
import { Shell } from "../../util/shell"
import { encodeKeySequence } from "../../util/pty-keys"
import type { ProcessParams, ProcessResult } from "./shared"

export namespace LocalProcessBackend {
  export async function execute(params: ProcessParams): Promise<ProcessResult> {
    const { action, processId } = params

    if (action === "list") {
      const all = ProcessRegistry.listAll()
      const processes = all.map((p) => ({
        processId: p.id,
        status: "exited" in p ? (p.exited ? toFinishedStatus(p.exitCode, p.exitSignal) : "running") : p.status,
        command: p.command.length > 80 ? p.command.slice(0, 77) + "..." : p.command,
        description: p.description,
        runtimeMs: ("endedAt" in p ? p.endedAt : Date.now()) - p.startedAt,
      }))

      const lines = processes.map((p) => {
        const duration = formatDuration(p.runtimeMs)
        const label = p.description || p.command
        return `${p.processId} ${p.status.padEnd(9)} ${duration} :: ${label}`
      })

      return {
        title: "Process list",
        metadata: { action, processes, backend: "local" },
        output: lines.length > 0 ? lines.join("\n") : "No running or recent processes.",
      }
    }

    if (!processId) {
      throw new Error("processId is required for this action")
    }

    const proc = ProcessRegistry.get(processId)
    const finished = ProcessRegistry.getFinished(processId)
    const target = proc || finished
    const procInfo = target ? { command: target.command, description: target.description } : {}

    switch (action) {
      case "poll": {
        if (proc && !proc.exited && params.block) {
          await waitForExit(processId, (params.timeout ?? 30) * 1000)
        }

        const current = ProcessRegistry.get(processId)
        const currentFinished = ProcessRegistry.getFinished(processId)
        const currentTarget = current || currentFinished
        const currentInfo = currentTarget
          ? { command: currentTarget.command, description: currentTarget.description }
          : procInfo

        if (current) {
          if (!current.backgrounded) {
            return {
              title: "Process not backgrounded",
              metadata: { action, processId, ...currentInfo, status: "error", backend: "local" },
              output: `Process ${processId} is not a background process.`,
            }
          }

          const status = current.exited ? toFinishedStatus(current.exitCode, current.exitSignal) : "running"
          const exitInfo = current.exited
            ? `\n\nProcess exited with ${current.exitSignal ? `signal ${current.exitSignal}` : `code ${current.exitCode ?? 0}`}.`
            : "\n\nProcess still running."

          return {
            title: `Process ${processId}`,
            metadata: {
              action,
              processId,
              ...currentInfo,
              status,
              exitCode: current.exited ? (current.exitCode ?? undefined) : undefined,
            },
            output: (current.tail || "(no output yet)") + exitInfo,
          }
        }

        if (currentFinished) {
          return {
            title: `Process ${processId}`,
            metadata: {
              action,
              processId,
              ...currentInfo,
              status: currentFinished.status,
              exitCode: currentFinished.exitCode ?? undefined,
            },
            output:
              (currentFinished.tail || "(no output recorded)") +
              `\n\nProcess exited with ${currentFinished.exitSignal ? `signal ${currentFinished.exitSignal}` : `code ${currentFinished.exitCode ?? 0}`}.`,
          }
        }

        return {
          title: "Process not found",
          metadata: { action, processId, status: "not_found", backend: "local" },
          output: `No process found for ${processId}`,
        }
      }

      case "log": {
        if (!target) {
          return {
            title: "Process not found",
            metadata: { action, processId, status: "not_found", backend: "local" },
            output: `No process found for ${processId}`,
          }
        }

        if (proc && !proc.backgrounded) {
          return {
            title: "Process not backgrounded",
            metadata: { action, processId, status: "error", backend: "local" },
            output: `Process ${processId} is not a background process.`,
          }
        }

        const output = target.output
        const lines = output.split("\n")
        const offset = params.offset ?? 0
        const limit = params.limit ?? lines.length
        const slice = lines.slice(offset, offset + limit).join("\n")

        const status =
          "exited" in target
            ? target.exited
              ? toFinishedStatus(target.exitCode, target.exitSignal)
              : "running"
            : target.status

        return {
          title: `Log: ${processId}`,
          metadata: { action, processId, ...procInfo, status, backend: "local" },
          output: slice || "(no output)",
        }
      }

      case "write": {
        if (!proc) {
          return {
            title: "Process not found",
            metadata: { action, processId, status: "not_found", backend: "local" },
            output: `No active process found for ${processId}`,
          }
        }

        if (!proc.backgrounded) {
          return {
            title: "Process not backgrounded",
            metadata: { action, processId, status: "error", backend: "local" },
            output: `Process ${processId} is not a background process.`,
          }
        }

        const stdin = proc.stdin ?? proc.child?.stdin
        if (!stdin || stdin.destroyed) {
          return {
            title: "Stdin not writable",
            metadata: { action, processId, status: "error", backend: "local" },
            output: `Process ${processId} stdin is not writable.`,
          }
        }

        await new Promise<void>((resolve, reject) => {
          stdin.write(params.data ?? "", (err) => {
            if (err) reject(err)
            else resolve()
          })
        })

        return {
          title: `Wrote to ${processId}`,
          metadata: { action, processId, ...procInfo, status: "running", backend: "local" },
          output: `Wrote ${(params.data ?? "").length} bytes to process ${processId}.`,
        }
      }

      case "send-keys": {
        if (!proc) {
          return {
            title: "Process not found",
            metadata: { action, processId, status: "not_found", backend: "local" },
            output: `No active process found for ${processId}`,
          }
        }

        if (!proc.backgrounded) {
          return {
            title: "Process not backgrounded",
            metadata: { action, processId, status: "error", backend: "local" },
            output: `Process ${processId} is not a background process.`,
          }
        }

        const stdin = proc.stdin ?? proc.child?.stdin
        if (!stdin || stdin.destroyed) {
          return {
            title: "Stdin not writable",
            metadata: { action, processId, status: "error", backend: "local" },
            output: `Process ${processId} stdin is not writable.`,
          }
        }

        const keys = params.keys ?? []
        if (keys.length === 0) {
          return {
            title: "No keys provided",
            metadata: { action, processId, status: "error", backend: "local" },
            output: "No key tokens provided for send-keys.",
          }
        }

        const { data, warnings } = encodeKeySequence(keys)
        if (!data) {
          return {
            title: "No key data",
            metadata: { action, processId, status: "error", backend: "local" },
            output: "No valid key data to send.",
          }
        }

        await new Promise<void>((resolve, reject) => {
          stdin.write(data, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })

        const warningText = warnings.length > 0 ? `\nWarnings: ${warnings.join(", ")}` : ""
        return {
          title: `Sent keys to ${processId}`,
          metadata: { action, processId, ...procInfo, status: "running", backend: "local" },
          output: `Sent ${data.length} bytes to process ${processId}.${warningText}`,
        }
      }

      case "kill": {
        if (!proc) {
          return {
            title: "Process not found",
            metadata: { action, processId, status: "not_found", backend: "local" },
            output: `No active process found for ${processId}`,
          }
        }

        if (!proc.backgrounded) {
          return {
            title: "Process not backgrounded",
            metadata: { action, processId, status: "error", backend: "local" },
            output: `Process ${processId} is not a background process.`,
          }
        }

        if (proc.child) {
          await Shell.killTree(proc.child, { exited: () => proc.exited })
        }
        ProcessRegistry.markExited(proc, null, "SIGKILL")

        return {
          title: `Killed ${processId}`,
          metadata: { action, processId, ...procInfo, status: "killed", backend: "local" },
          output: `Killed process ${processId}.`,
        }
      }

      case "clear": {
        if (!finished) {
          if (proc) {
            return {
              title: "Process still running",
              metadata: { action, processId, status: "error", backend: "local" },
              output: `Process ${processId} is still running. Use kill or remove instead.`,
            }
          }
          return {
            title: "Process not found",
            metadata: { action, processId, status: "not_found", backend: "local" },
            output: `No finished process found for ${processId}`,
          }
        }

        ProcessRegistry.remove(processId)
        return {
          title: `Cleared ${processId}`,
          metadata: { action, processId, ...procInfo, status: "cleared", backend: "local" },
          output: `Cleared process ${processId} from history.`,
        }
      }

      case "remove": {
        if (proc) {
          if (proc.backgrounded && proc.child) {
            await Shell.killTree(proc.child, { exited: () => proc.exited })
          }
          ProcessRegistry.markExited(proc, null, "SIGKILL")
        }
        ProcessRegistry.remove(processId)

        return {
          title: `Removed ${processId}`,
          metadata: { action, processId, ...procInfo, status: "removed", backend: "local" },
          output: `Removed process ${processId}.`,
        }
      }

      default:
        throw new Error(`Unknown action: ${action}`)
    }
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`.padStart(6)
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m${secs}s`.padStart(6)
}

function waitForExit(processId: string, timeoutMs: number): Promise<void> {
  const POLL_INTERVAL = 2000
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      const proc = ProcessRegistry.get(processId)
      if (!proc || proc.exited) return resolve()
      if (Date.now() >= deadline) return resolve()
      setTimeout(check, POLL_INTERVAL)
    }
    check()
  })
}

function toFinishedStatus(
  exitCode: number | null | undefined,
  exitSignal: NodeJS.Signals | number | null | undefined,
): "completed" | "failed" | "killed" {
  if (exitSignal === "SIGKILL" || exitSignal === "SIGTERM") {
    return "killed"
  }
  return (exitCode ?? 0) === 0 ? "completed" : "failed"
}
