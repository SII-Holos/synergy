import fs from "node:fs/promises"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

const sourceIndex = process.argv.indexOf("--source-home")
if (sourceIndex < 0 || !process.argv[sourceIndex + 1])
  throw new Error("The isolated Source child requires its original source-home argument")
const sourceHome = await fs.realpath(process.argv[sourceIndex + 1])
let stopped = false
const freeze = RuntimeMaintenance.freeze
RuntimeMaintenance.freeze = new Proxy(freeze, {
  async apply(method, receiver, args) {
    const result = await Reflect.apply(method, receiver, args)
    if (stopped || RuntimeContext.current().host.home !== sourceHome) return result
    const operation = await RuntimeMaintenance.assertHeld(args[0])
    if (operation.purpose !== "organization-backup" || operation.phase !== "frozen") return result
    stopped = true
    process.stdout.write(
      JSON.stringify({
        state: "source-preselection-frozen",
        operation: {
          maintenanceID: operation.maintenanceID,
          requestID: operation.requestID,
          requestHash: operation.requestHash,
          sourceRuntimeID: operation.sourceRuntimeID,
          cohortHash: operation.cohortHash,
          phase: operation.phase,
          actor: operation.actor,
        },
      }) + "\n",
    )
    await new Promise(() => setInterval(() => {}, 1000))
    return result
  },
})

await import("../../src/entry.ts")
