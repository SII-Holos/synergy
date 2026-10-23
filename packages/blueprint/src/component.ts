import { componentFeatures } from "./features"
import { registerAgentContributions } from "./agent-contributions"
import { registerSessionMigrations } from "./session-migration"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerSessionSchema } from "./session-schema"
import { registerBlueprintMigrations } from "./blueprint/migration"
import { registerSessions } from "./session/register"
import { registerBlueprintDomain } from "./blueprint/register"
import { registerBlueprintSessionState } from "./blueprint/session-state"
import { registerSuperPlanSessionEnv } from "./superplan/session-env"
import { registerBlueprintNoteKind } from "./note-kind"
import { registerAgents } from "./agents"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { LoopEvent } from "./blueprint/event"
import { SuperPlanEvent } from "./superplan/event"
import { clearDeadlineTimers } from "./blueprint/deadline"
export function blueprint(): RuntimeComponent {
  return {
    id: "blueprint",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, note: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    services: () => ({
      async disposeExtensions() {
        clearDeadlineTimers()
      },
    }),
    register() {
      registerAgentContributions()
      registerSessionMigrations()
      registerSessionSchema()
      registerBlueprintMigrations()
      registerSessions()
      registerBlueprintDomain()
      registerBlueprintSessionState()
      registerSuperPlanSessionEnv()
      registerBlueprintNoteKind()
      registerAgents()
      BusEvent.register(...Object.values(LoopEvent))
      BusEvent.register(...Object.values(SuperPlanEvent))
    },
  }
}
