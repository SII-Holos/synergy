import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
import { BossRuntime } from "@ericsanchezok/synergy-boss/boss/boss-runtime"
export function bossFeishu(): RuntimeComponent {
  return {
    id: "boss-feishu",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { boss: version, "channel-feishu": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({ resident: { async start() {}, ready: () => BossRuntime.ensure(), async stop() {} } }),
    register() {
      registerBridge()
    },
  }
}
