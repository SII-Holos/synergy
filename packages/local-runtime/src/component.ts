import { RuntimeReload } from "./reload"
import { RuntimeReloadExecutor } from "@ericsanchezok/synergy-harness/config/reload-executor"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { FileWatcher } from "./file/watcher"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerLocalRuntime } from "./register"

export function localRuntime(options: { workers?: boolean } = {}): RuntimeComponent {
  return {
    id: "local-runtime",
    apiVersion: 1,
    version,
    requires: {},
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      reload: { start: () => RuntimeReload.startAutoReload(), stop: () => RuntimeReload.stopAutoReload() },
      resident: {
        async start() {
          await SessionRecovery.reconcileRuntimeState({ scopeID: Scope.home().id, apply: true }).catch((error) => {
            Log.create({ service: "local-runtime" }).warn("session runtime recovery failed", { error })
          })
          FileWatcher.init()
        },
        async ready() {
          await SessionInvoke.reconcilePausedSessions(Scope.home().id)
        },
        async stop() {},
      },
    }),
    register() {
      registerLocalRuntime(options)
      RuntimeReloadExecutor.setExecutor((input, options) => RuntimeReload.reload(input, options))
      RuntimeReloadExecutor.setGlobalExecutor((input, options) => RuntimeReload.reloadGlobal(input, options))
    },
  }
}
