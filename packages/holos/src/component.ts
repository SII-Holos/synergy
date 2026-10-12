import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerHolosMigrations } from "./holos/migration"
import { registerHolosRuntime } from "./holos/runtime"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { HolosRuntime } from "./holos/runtime"
import { Contact } from "./holos/contact"
import { registerReload } from "./reload"
export function holos(): RuntimeComponent {
  return {
    id: "holos",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({ resident: { start: () => HolosRuntime.init(), async stop() {} } }),
    adapters: { http: new URL("./http.ts", import.meta.url), cli: new URL("./cli-adapter.ts", import.meta.url) },
    register() {
      AgentPromptContributions.register("holos", [
        {
          requiredTools: ["session_read"],
          render: () =>
            "Use session_read with a contact target to read a Holos contact conversation. A Holos identity’s remote profile is authoritative; do not create a local profile document.",
        },
      ])
      registerConfig()
      registerHolosMigrations()
      registerHolosRuntime()
      BusEvent.register(...Object.values(HolosRuntime.Event))
      BusEvent.register(...Object.values(Contact.Event))
      registerReload()
    },
  }
}
