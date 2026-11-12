import { z } from "zod"
import { Storage } from "./storage"
import { RuntimeMaintenanceSchema } from "./runtime-maintenance-schema"

export namespace MaintenanceRetirementRecords {
  export const prefix = ["runtime_maintenance", "retirements"]
  export const Info = z.strictObject({
    version: z.literal(1),
    source: RuntimeMaintenanceSchema.Info.refine(
      (source) => source.purpose === "organization-backup" && source.phase === "frozen",
      "Retirement requires its original frozen source operation",
    ),
    referenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  export type Info = z.infer<typeof Info>
  export const key = (maintenanceID: string) => [...prefix, maintenanceID]
  export function parse(address: readonly string[], value: unknown) {
    const record = Info.parse(value)
    if (JSON.stringify(address) !== JSON.stringify(key(record.source.maintenanceID)))
      throw new Error("Maintenance retirement belongs to another canonical address")
    return record
  }
  export async function read(maintenanceID: string) {
    const address = key(maintenanceID)
    const [value] = await Storage.readMany([address])
    return value === undefined ? undefined : parse(address, value)
  }
}
