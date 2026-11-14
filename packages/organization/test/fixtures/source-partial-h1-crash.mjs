import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native.ts"

const argument = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error("The isolated Source child requires " + name)
  return process.argv[index + 1]
}
const sourceHome = await fs.realpath(argument("--source-home"))
const requestedWork = argument("--work")
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
let sourceLease
let stopped = false
const freeze = RuntimeMaintenance.freeze
RuntimeMaintenance.freeze = new Proxy(freeze, {
  async apply(method, receiver, args) {
    const result = await Reflect.apply(method, receiver, args)
    if (RuntimeContext.current().host.home !== sourceHome) return result
    const operation = await RuntimeMaintenance.assertHeld(args[0])
    if (operation.version === 3 && operation.purpose === "organization-backup" && operation.phase === "frozen")
      sourceLease = args[0]
    return result
  },
})
const capture = Native.capture
Native.capture = new Proxy(capture, {
  async apply(method, receiver, args) {
    if (stopped || RuntimeContext.current().host.home !== sourceHome) return Reflect.apply(method, receiver, args)
    const input = args[0]
    if (!sourceLease || input.lease !== sourceLease)
      throw new Error("Partial H1 observation requires the original Source producer lease")
    const operation = await RuntimeMaintenance.assertHeld(sourceLease)
    if (operation.version !== 3 || operation.purpose !== "organization-backup" || operation.phase !== "frozen")
      throw new Error("Partial H1 observation requires the actual frozen Source preparation")
    const archive = SnapshotMaintenance.assertArchive(input.archive)
    const work = await fs.realpath(requestedWork)
    if (archive.directory !== path.join(work, "h1", "records") || input.directory !== path.join(work, "h1", "native"))
      throw new Error("Partial H1 observation selected another original capture")
    await StorageCheckpoint.verifyArchive({
      directory: archive.directory,
      expected: archive.namespace,
      keys: input.keys,
      signal: input.signal,
    })
    if ((await fs.exists(input.directory)) || (await fs.exists(path.join(work, "reference.json"))))
      throw new Error("Partial H1 observation must precede native capture and Reference publication")
    stopped = true
    process.stdout.write(
      JSON.stringify({
        state: "source-records-complete-native-absent",
        operation: {
          maintenanceID: operation.maintenanceID,
          requestID: operation.requestID,
          requestHash: operation.requestHash,
          sourceRuntimeID: operation.sourceRuntimeID,
          cohortHash: operation.cohortHash,
          phase: operation.phase,
          actor: operation.actor,
        },
        records: {
          archiveID: archive.namespace.archiveID,
          namespaceID: archive.namespace.namespaceID,
          manifestHash: hash(archive.namespace),
        },
      }) + "\n",
    )
    await new Promise(() => setInterval(() => {}, 1000))
  },
})

await import("../../src/entry.ts")
