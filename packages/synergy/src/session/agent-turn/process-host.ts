import fs from "fs"
import { fileURLToPath } from "url"
import { AgentTurnProtocol } from "./protocol"

const runnerPath = fileURLToPath(new URL("./runner.ts", import.meta.url))

export interface AgentWorkerProcess {
  readonly process: Bun.Subprocess
  send(message: AgentTurnProtocol.HostToWorker): void
  stop(graceMs: number): Promise<void>
}

export interface SpawnAgentWorkerProcessOptions {
  onMessage(message: AgentTurnProtocol.WorkerToHost): void
  onExit(exitCode: number | null, signal: string | null): void
}

export function resolveAgentWorkerCommand(): string[] {
  if (fs.existsSync(runnerPath)) return [process.execPath, "run", runnerPath]
  return [process.execPath, "__agent-turn-runner"]
}

export function spawnAgentWorkerProcess(options: SpawnAgentWorkerProcessOptions): AgentWorkerProcess {
  const processHandle = Bun.spawn({
    cmd: resolveAgentWorkerCommand(),
    env: {
      ...process.env,
      SYNERGY_AGENT_WORKER: "1",
      SYNERGY_AGENT_PARENT_PID: String(process.pid),
    },
    ipc(message) {
      try {
        const parsed = AgentTurnProtocol.parseWorkerToHost(typeof message === "string" ? JSON.parse(message) : message)
        AgentTurnProtocol.assertIpcFrameBound(parsed)
        options.onMessage(parsed)
      } catch {
        processHandle.kill()
      }
    },
    stdout: "ignore",
    stderr: "ignore",
    onExit(_process, exitCode, signalCode) {
      options.onExit(exitCode, signalCode?.toString() ?? null)
    },
  })

  return {
    process: processHandle,
    send(message) {
      AgentTurnProtocol.assertIpcFrameBound(message)
      processHandle.send(message)
    },
    async stop(graceMs) {
      if (processHandle.exitCode !== null) return
      try {
        processHandle.send({ type: "shutdown" } satisfies AgentTurnProtocol.HostToWorker)
      } catch {
        processHandle.kill()
        await processHandle.exited.catch(() => undefined)
        return
      }
      const exited = await Promise.race([
        processHandle.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ])
      if (!exited) {
        processHandle.kill()
        await processHandle.exited.catch(() => undefined)
      }
    },
  }
}
