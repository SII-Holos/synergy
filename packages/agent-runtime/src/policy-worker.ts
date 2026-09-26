import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { startPolicyWorker } from "@ericsanchezok/synergy-harness/enforcement/policy-worker/runner"
import { registerWorkerComponents } from "./workers"

await RuntimeContext.create(createLocalHost()).run(async () => {
  await registerWorkerComponents("policy")
  startPolicyWorker()
})
