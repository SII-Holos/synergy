import z from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

const IncompatiblePluginRecord = z.object({
  pluginId: z.string(),
  spec: z.string().optional(),
  reason: z.literal("reinstallRequired"),
})

export type IncompatiblePluginRecord = z.infer<typeof IncompatiblePluginRecord>

export namespace IncompatiblePluginStore {
  export async function read(): Promise<IncompatiblePluginRecord[]> {
    const [value] = await Storage.readMany([["plugin-incompatible"]])
    return value === undefined ? [] : z.array(IncompatiblePluginRecord).parse(value)
  }

  export async function write(records: IncompatiblePluginRecord[]): Promise<void> {
    await Storage.write(["plugin-incompatible"], records)
  }

  export function withoutPlugin(records: IncompatiblePluginRecord[], pluginId: string, specs: string[] = []) {
    const removedSpecs = new Set(specs)
    return records.filter((record) => record.pluginId !== pluginId && (!record.spec || !removedSpecs.has(record.spec)))
  }
}
