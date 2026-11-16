import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native.ts"
import { OrganizationSourceRetirement as Retirement } from "../../src/backup/source-retirement.ts"

const mode = process.env.SYNERGY_TEST_REFERENCE_CRASH
if (mode !== "before-reference" && mode !== "reference-ack-lost")
  throw new Error("Select the exact reference fault boundary")
const argument = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error("The isolated Source child requires " + name)
  return process.argv[index + 1]
}
const sourceHome = await fs.realpath(argument("--source-home"))
const requestedWork = argument("--work")
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
let sourceLease
let captured
let stopped = false
const freeze = RuntimeMaintenance.freeze
RuntimeMaintenance.freeze = new Proxy(freeze, {
  async apply(method, receiver, args) {
    const result = await Reflect.apply(method, receiver, args)
    if (RuntimeContext.current().host.home === sourceHome) {
      const info = await RuntimeMaintenance.assertHeld(args[0])
      if (info.version === 3 && info.purpose === "organization-backup" && info.phase === "frozen") sourceLease = args[0]
    }
    return result
  },
})
const capture = Native.capture
Native.capture = new Proxy(capture, {
  async apply(method, receiver, args) {
    const result = await Reflect.apply(method, receiver, args)
    if (RuntimeContext.current().host.home === sourceHome && args[0].lease === sourceLease)
      captured = { records: SnapshotMaintenance.assertArchive(args[0].archive), native: result, keys: args[0].keys }
    return result
  },
})
const write = FileAtomicWrite.write
FileAtomicWrite.write = new Proxy(write, {
  async apply(method, receiver, args) {
    if (
      stopped ||
      RuntimeContext.current().host.home !== sourceHome ||
      args[1].length !== 1 ||
      args[1][0] !== "reference.json"
    )
      return Reflect.apply(method, receiver, args)
    if (!sourceLease || !captured)
      throw new Error("Reference observation requires the original complete native capture")
    const operation = await RuntimeMaintenance.assertHeld(sourceLease)
    if (operation.version !== 3 || operation.phase !== "frozen")
      throw new Error("Reference observation lost the actual Source preparation")
    const work = await fs.realpath(requestedWork)
    if (
      captured.records.directory !== path.join(work, "h1", "records") ||
      captured.native.directory !== path.join(work, "h1", "native")
    )
      throw new Error("Reference observation selected another original H1")
    const records = await StorageCheckpoint.verifyArchive({
      directory: captured.records.directory,
      expected: captured.records.namespace,
      keys: captured.keys,
    })
    const native = await StorageCheckpoint.verifyArchive({
      directory: captured.native.directory,
      expected: captured.native.namespace,
      keys: captured.keys,
    })
    const fixed = await Native.verify({
      directory: captured.native.directory,
      expected: native,
      source: records,
      keys: captured.keys,
    })
    fixed.rawConfiguration?.fill(0)
    const selector = JSON.parse(Buffer.from(args[2]).toString("utf8"))
    const reference = Retirement.Reference.parse(selector.reference)
    if (hash(reference.current.maintenance) !== hash(operation))
      throw new Error("Reference observation has another original operation")
    const filename = path.join(work, "reference.json")
    if (await fs.exists(filename)) throw new Error("The original Reference was already present before its first write")
    if (mode === "reference-ack-lost") {
      await Reflect.apply(method, receiver, args)
      if (!Buffer.from(await fs.readFile(filename)).equals(Buffer.from(args[2])))
        throw new Error("The actual durable Reference does not match the original write")
    }
    stopped = true
    process.stdout.write(
      JSON.stringify({
        state: mode,
        operation: {
          maintenanceID: operation.maintenanceID,
          requestID: operation.requestID,
          requestHash: operation.requestHash,
          sourceRuntimeID: operation.sourceRuntimeID,
          cohortHash: operation.cohortHash,
          phase: operation.phase,
          actor: operation.actor,
        },
        referenceHash: hash(reference),
        records: { archiveID: records.archiveID, manifestHash: hash(records) },
        native: { archiveID: native.archiveID, manifestHash: hash(native) },
      }) + "\n",
    )
    await new Promise(() => setInterval(() => {}, 1000))
  },
})

await import("../../src/entry.ts")
