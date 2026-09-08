import fs from "fs"
import { fileURLToPath } from "url"
import { PolicyWorkerProtocol } from "./protocol"

const runnerPath = fileURLToPath(new URL("./runner.ts", import.meta.url))

export interface PolicyWorkerProcess {
  readonly process: Bun.Subprocess
  send(message: PolicyWorkerProtocol.HostToWorker): void
  stop(graceMs: number): Promise<void>
}

export interface SpawnPolicyWorkerProcessOptions {
  onMessage(message: PolicyWorkerProtocol.WorkerToHost): void
  onExit(exitCode: number | null, signal: string | null): void
}

export function resolvePolicyWorkerCommand(): string[] {
  if (fs.existsSync(runnerPath)) return [process.execPath, "run", runnerPath]
  return [process.execPath, "__policy-worker-runner"]
}

export function spawnPolicyWorkerProcess(options: SpawnPolicyWorkerProcessOptions): PolicyWorkerProcess {
  const processHandle = Bun.spawn({
    cmd: resolvePolicyWorkerCommand(),
    env: {
      ...process.env,
      SYNERGY_POLICY_WORKER: "1",
      SYNERGY_POLICY_PARENT_PID: String(process.pid),
    },
    ipc(message) {
      try {
        const parsed = PolicyWorkerProtocol.parseWorkerToHost(
          typeof message === "string" ? JSON.parse(message) : message,
        )
        PolicyWorkerProtocol.assertIpcFrameBound(parsed)
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
      PolicyWorkerProtocol.assertIpcFrameBound(message)
      processHandle.send(message)
    },
    async stop(graceMs) {
      if (processHandle.exitCode !== null) return
      try {
        processHandle.send({ type: "shutdown" } satisfies PolicyWorkerProtocol.HostToWorker)
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
