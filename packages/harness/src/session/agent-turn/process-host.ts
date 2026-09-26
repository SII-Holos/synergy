import { RuntimeContext } from "../../lifecycle/context"
import fs from "fs"
import { fileURLToPath } from "url"
import { AgentTurnProtocol } from "./protocol"

const runtimeState = RuntimeContext.state(() => ({
  runtimeEntrypoint: undefined as string | undefined,
}))

export function registerAgentWorkerEntrypoint(entrypoint: URL): void {
  const instanceState = runtimeState()

  const filename = fileURLToPath(entrypoint)
  if (instanceState.runtimeEntrypoint === filename) return
  RuntimeContext.assertCompositionOpen("Agent worker entrypoint")
  instanceState.runtimeEntrypoint = filename
}

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
  const instanceState = runtimeState()

  if (instanceState.runtimeEntrypoint && fs.existsSync(instanceState.runtimeEntrypoint))
    return [process.execPath, "run", instanceState.runtimeEntrypoint]
  if (!instanceState.runtimeEntrypoint) throw new Error("No agent worker host is registered")
  return [process.execPath, "__agent-turn-runner"]
}

export function spawnAgentWorkerProcess(options: SpawnAgentWorkerProcessOptions): AgentWorkerProcess {
  const owner = RuntimeContext.current()
  const processHandle = Bun.spawn({
    cmd: resolveAgentWorkerCommand(),
    env: {
      ...owner.host.env,
      SYNERGY_HOME: owner.host.home,
      SYNERGY_RUNTIME_ROOT: owner.host.root,
      SYNERGY_AGENT_WORKER: "1",
      SYNERGY_AGENT_PARENT_PID: String(process.pid),
    },
    ipc(message) {
      try {
        const parsed = AgentTurnProtocol.parseWorkerToHost(typeof message === "string" ? JSON.parse(message) : message)
        AgentTurnProtocol.assertIpcFrameBound(parsed)
        owner.run(() => options.onMessage(parsed))
      } catch {
        processHandle.kill()
      }
    },
    stdout: "ignore",
    stderr: "ignore",
    onExit(_process, exitCode, signalCode) {
      owner.run(() => options.onExit(exitCode, signalCode?.toString() ?? null))
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
      let timer: ReturnType<typeof setTimeout> | undefined
      const exited = await Promise.race([
        processHandle.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs)
        }),
      ]).finally(() => clearTimeout(timer))
      if (!exited) {
        processHandle.kill()
        await processHandle.exited.catch(() => undefined)
      }
    },
  }
}
