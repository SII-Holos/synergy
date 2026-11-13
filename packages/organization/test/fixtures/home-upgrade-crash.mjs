import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { upgradeOrganizationServiceHome } from "../../src/home-upgrade.ts"

const home = process.env.SYNERGY_HOME
const requestID = process.env.SERVICE_UPGRADE_TEST_REQUEST
if (!home || !requestID) throw new Error("The isolated upgrade child requires its original Home and request")
const filename = path.join(home, ".synergy", "home-ownership.json")
const open = fs.open
const phase = process.env.SERVICE_UPGRADE_TEST_PHASE ?? "frozen"
let retained = false
async function barrier() {
  const operation = await RuntimeMaintenance.status()
  if (retained || operation?.phase !== phase) return
  retained = true
  process.stdout.write(
    JSON.stringify({
      state: "upgrade-barrier",
      phase,
      operation: {
        maintenanceID: operation.maintenanceID,
        sourceRuntimeID: operation.sourceRuntimeID,
        requestID: operation.requestID,
        requestHash: operation.requestHash,
      },
    }) + "\n",
  )
  await new Promise(() => {})
}
for (const [method, expected] of [
  ["begin", "draining"],
  ["assertReleasing", "releasing"],
  ["release", "released"],
]) {
  const original = RuntimeMaintenance[method]
  RuntimeMaintenance[method] = new Proxy(original, {
    async apply(owner, receiver, args) {
      const result = await Reflect.apply(owner, receiver, args)
      if (phase === expected) await barrier()
      return result
    },
  })
}
fs.open = new Proxy(open, {
  async apply(method, receiver, args) {
    const file = await Reflect.apply(method, receiver, args)
    if (args[0] === filename && typeof args[1] === "number") {
      const sync = file.sync.bind(file)
      file.sync = async () => {
        await sync()
        const marker = JSON.parse(await fs.readFile(filename, "utf8"))
        if (phase === "frozen" && marker.readerContract === "native-organization-service-environments-v1")
          await barrier()
      }
    }
    return file
  },
})
await upgradeOrganizationServiceHome({ home, requestID })
