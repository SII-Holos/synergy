import { installedWorkerCommand } from "@ericsanchezok/synergy-util/installed-launcher"
import { RuntimeContext } from "../../lifecycle/context"
import fs from "fs"
import { fileURLToPath } from "url"
import { PolicyWorkerProtocol } from "./protocol"

const state = RuntimeContext.state(() => ({
  entrypoint: undefined as string | undefined,
  environment: {} as Readonly<Record<string, string>>,
}))

export function registerPolicyWorkerEntrypoint(entrypoint: URL, environment: Readonly<Record<string, string>> = {}) {
  const filename = fileURLToPath(entrypoint)
  if (state().entrypoint === filename && JSON.stringify(state().environment) === JSON.stringify(environment)) return
  RuntimeContext.assertCompositionOpen("policy worker entrypoint")
  if (state().entrypoint) throw new Error("Policy worker entrypoint is already registered")
  state().entrypoint = filename
  state().environment = Object.freeze({ ...environment })
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
  const installed = installedWorkerCommand(RuntimeContext.current().host.env, "__policy-worker-runner")
  if (installed) return installed
  const entrypoint = state().entrypoint
  if (!entrypoint) throw new Error("No policy worker host is registered")
  if (fs.existsSync(entrypoint))
    return [
      process.execPath,
      "run",
      "--no-env-file",
      `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      entrypoint,
    ]
  return [process.execPath, "__policy-worker-runner"]
}

export function spawnPolicyWorkerProcess(options: SpawnPolicyWorkerProcessOptions): PolicyWorkerProcess {
  const owner = RuntimeContext.current()
  const exitCallback = Promise.withResolvers<void>()
  const processHandle = Bun.spawn({
    cmd: resolvePolicyWorkerCommand(),
    cwd: owner.host.root,
    env: {
      ...owner.host.env,
      ...state().environment,
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
      try {
        Promise.resolve(owner.run(() => options.onExit(exitCode, signalCode?.toString() ?? null))).then(
          exitCallback.resolve,
          exitCallback.reject,
        )
      } catch (error) {
        exitCallback.reject(error)
      }
    },
  })

  return {
    process: processHandle,
    send(message) {
      PolicyWorkerProtocol.assertIpcFrameBound(message)
      processHandle.send(message)
    },
    async stop(graceMs) {
      void exitCallback.promise.catch(() => {})
      if (processHandle.exitCode !== null) {
        await exitCallback.promise
        return
      }
      try {
        processHandle.send({ type: "shutdown" } satisfies PolicyWorkerProtocol.HostToWorker)
      } catch {
        processHandle.kill()
        await processHandle.exited.catch(() => undefined)
        await exitCallback.promise
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
      await exitCallback.promise
    },
  }
}
