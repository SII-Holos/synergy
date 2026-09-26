import { registerReload } from "./reload"
import { LatticeRuntime } from "./lattice/runtime"
import { Agenda } from "./agenda"
import { BossRuntime } from "./boss/boss-runtime"
import { AnimaSchedule } from "./anima-schedule"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerSessionMigrations } from "./session-migration"
import { registerAgendaMigrations } from "./agenda/migration"
import { registerBlueprintMigrations } from "./blueprint/migration"
import { registerLatticeMigrations } from "./lattice/migration"
import { registerWorkflowSessions } from "./session/register"
import { registerWorkflowsAgents } from "./agents"
import { registerBossDomain } from "./boss/register"
import { registerLightLoopDomain } from "./light-loop/register"
import { registerBlueprintDomain } from "./blueprint/register"
import { registerLatticeDomain } from "./lattice/register"
import { registerAgendaTools } from "./agenda/tools"
import { registerLatticeStartup } from "./lattice/startup"
import { registerBlueprintSessionState } from "./blueprint/session-state"
import { registerAgendaSessionSignals } from "./agenda/session-signals"
import { registerSuperPlanSessionEnv } from "./superplan/session-env"
import { setTerminalHookDeliverer } from "./light-loop/runtime"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { setBlueprintAgendaAssertClear } from "./blueprint/tools/blueprint-loop-stop"
import { setLightLoopAgendaAssertClear } from "./light-loop/tools/loop-stop"
import { AgendaSessionWakeup } from "./agenda/session-wakeup"
import {
  registerPluginLightLoopAdapter,
  registerPluginBlueprintAdapter,
} from "@ericsanchezok/synergy-plugin-host/plugin/host-services"
import { lightLoopPluginAdapter } from "./light-loop/plugin-adapter"
import { startBlueprint, getBlueprint, cancelBlueprint } from "./blueprint/plugin-adapter"
import { registerConfig } from "./config-schema"
import { registerSessionSchema } from "./session-schema"

export function workflows(): RuntimeComponent {
  return {
    id: "workflows",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, library: version, note: version, "plugin-host": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      resident: {
        async start() {
          await LatticeRuntime.init()
        },
        async ready() {
          await Agenda.start()
          await AnimaSchedule.seed()
          await BossRuntime.ensure().catch((error) => {
            Log.create({ service: "workflows" }).warn("runtime boss provisioning failed", { error })
          })
        },
        async stop() {
          Agenda.stop()
        },
      },
    }),
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerReload()
      registerConfig()
      registerSessionSchema()
      registerSessionMigrations()
      registerAgendaMigrations()
      registerBlueprintMigrations()
      registerLatticeMigrations()
      registerWorkflowSessions()
      registerWorkflowsAgents()
      registerBossDomain()
      registerLightLoopDomain()
      registerBlueprintDomain()
      registerLatticeDomain()
      registerAgendaTools()
      registerLatticeStartup()
      registerBlueprintSessionState()
      registerAgendaSessionSignals()
      registerSuperPlanSessionEnv()
      setTerminalHookDeliverer((pluginId, generation, point, input) =>
        Plugin.deliverHookForPlugin(pluginId, generation, point, input),
      )
      setBlueprintAgendaAssertClear((input) => AgendaSessionWakeup.assertClear(input))
      setLightLoopAgendaAssertClear((input) => AgendaSessionWakeup.assertClear(input))
      registerPluginLightLoopAdapter(lightLoopPluginAdapter)
      registerPluginBlueprintAdapter({ start: startBlueprint, get: getBlueprint, cancel: cancelBlueprint })
    },
  }
}
