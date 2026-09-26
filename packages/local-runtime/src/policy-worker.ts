import { createLocalHost } from "./host"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

await RuntimeContext.create(createLocalHost()).run(async () => {
  const { startPolicyWorker } = await import("@ericsanchezok/synergy-harness/enforcement/policy-worker/runner")
  startPolicyWorker()
})
