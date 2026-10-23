import { componentFeatures } from "./features"
import { AgendaItemOwners } from "@ericsanchezok/synergy-agenda/agenda/item-owners"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerMigrations } from "./migration"
import { registerClarusAssignmentLifecycle } from "./channel/provider/clarus/assignment-lifecycle"
import { ClarusProvider } from "./channel/provider/clarus"
import { Channel } from "@ericsanchezok/synergy-channels/channel"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ClarusSubmitTaskResultTool } from "./channel/tools/clarus-submit-task-result"
import { ClarusExtendTaskTool } from "./channel/tools/clarus-extend-task"
import { registerAccountConfigured } from "@ericsanchezok/synergy-holos/holos/account-configured"
import { ensureClarusChannelAccount } from "./account-configured"
export function channelClarus(): RuntimeComponent {
  return {
    id: "channel-clarus",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { channels: version, holos: version, agenda: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      AgendaItemOwners.register("channel-clarus")
      registerConfig()
      registerMigrations()
      registerClarusAssignmentLifecycle()
      Channel.registerProvider(new ClarusProvider())
      ToolRegistry.registerToolProvider("channel-clarus", () => [ClarusSubmitTaskResultTool, ClarusExtendTaskTool])
      registerAccountConfigured("channel-clarus", ensureClarusChannelAccount)
    },
  }
}
