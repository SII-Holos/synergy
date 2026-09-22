import { RuntimeContext } from "../../lifecycle/context"
import fs from "fs"
import { fileURLToPath } from "url"
import { PolicyWorkerProtocol } from "./protocol"

const state = RuntimeContext.state(() => ({ entrypoint: undefined as string | undefined }))

export function registerPolicyWorkerEntrypoint(entrypoint: URL) {
  const filename = fileURLToPath(entrypoint)
  if (state().entrypoint === filename) return
  RuntimeContext.assertCompositionOpen("policy worker entrypoint")
  if (state().entrypoint) throw new Error("Policy worker entrypoint is already registered")
  state().entrypoint = filename
}

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
  const entrypoint = state().entrypoint
  if (!entrypoint) throw new Error("No policy worker host is registered")
  if (fs.existsSync(entrypoint)) return [process.execPath, "run", entrypoint]
  return [process.execPath, "__policy-worker-runner"]
}

export function spawnPolicyWorkerProcess(options: SpawnPolicyWorkerProcessOptions): PolicyWorkerProcess {
  const owner = RuntimeContext.current()
  const processHandle = Bun.spawn({
    cmd: resolvePolicyWorkerCommand(),
    env: {
      ...owner.host.env,
      SYNERGY_HOME: owner.host.home,
      SYNERGY_RUNTIME_ROOT: owner.host.root,
      SYNERGY_POLICY_WORKER: "1",
      SYNERGY_POLICY_PARENT_PID: String(process.pid),
    },
    ipc(message) {
      try {
        const parsed = PolicyWorkerProtocol.parseWorkerToHost(
          typeof message === "string" ? JSON.parse(message) : message,
        )
        PolicyWorkerProtocol.assertIpcFrameBound(parsed)
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
      let timeout: ReturnType<typeof setTimeout> | undefined
      const exited = await Promise.race([
        processHandle.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), graceMs)
        }),
      ]).finally(() => clearTimeout(timeout))
      if (!exited) {
        processHandle.kill()
        await processHandle.exited.catch(() => undefined)
      }
    },
  }
}
