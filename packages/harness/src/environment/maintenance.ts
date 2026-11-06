import { WorkspaceOperations } from "../workspace/operations"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { Environment } from "."
import { EnvironmentExecution } from "./execution"
import { WorkspaceMounts } from "../workspace/mount"

export namespace EnvironmentMaintenance {
  const state = RuntimeContext.state(() => ({
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    pending: undefined as Promise<void> | undefined,
  }))
  const log = Log.create({ service: "environment-maintenance" })

  export function start() {
    const current = state()
    current.timer ??= setInterval(() => {
      void tick().catch((error) => log.warn("Environment maintenance failed", { error }))
    }, 15_000)
    current.timer.unref()
    return async () => {
      clearInterval(current.timer)
      current.timer = undefined
      await current.pending
    }
  }

  export function tick(now = Date.now()) {
    const current = state()
    return (current.pending ??= run(now).finally(() => {
      current.pending = undefined
    }))
  }

  async function run(now: number) {
    const scopes = new Set<string>()
    for (const key of await Storage.list(StoragePath.environmentActive())) {
      const [scopeID] = await Storage.readMany<string>([key])
      if (!scopeID) continue
      scopes.add(scopeID)
      try {
        const info = await Environment.get(key[1], scopeID)
        if (info.state !== "ready") await Environment.reconcile(info.id, scopeID)
      } catch (error) {
        log.warn("Environment allocation remains pending reconciliation", { environmentID: key[1], error })
      }
    }
    await EnvironmentExecution.recover()
    await WorkspaceOperations.recover()
    await WorkspaceMounts.recover()
    for (const scopeID of scopes) await Environment.reclaimIdle(scopeID, now)
  }
}
