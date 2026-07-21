import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"

const IncompatiblePluginRecord = z.object({
  pluginId: z.string(),
  spec: z.string().optional(),
  reason: z.literal("reinstallRequired"),
})

export type IncompatiblePluginRecord = z.infer<typeof IncompatiblePluginRecord>

function filepath(data: string) {
  return path.join(data, "plugin-incompatible.json")
}

export namespace IncompatiblePluginStore {
  export async function read(data = Global.Path.data): Promise<IncompatiblePluginRecord[]> {
    try {
      const value = JSON.parse(await fs.readFile(filepath(data), "utf8"))
      return z.array(IncompatiblePluginRecord).parse(value)
    } catch (error: any) {
      if (error?.code === "ENOENT") return []
      throw error
    }
  }

  export async function write(records: IncompatiblePluginRecord[], data = Global.Path.data): Promise<void> {
    const file = filepath(data)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    await Bun.write(temporary, `${JSON.stringify(records, null, 2)}\n`)
    await fs.rename(temporary, file)
  }

  export function withoutPlugin(records: IncompatiblePluginRecord[], pluginId: string, specs: string[] = []) {
    const removedSpecs = new Set(specs)
    return records.filter((record) => record.pluginId !== pluginId && (!record.spec || !removedSpecs.has(record.spec)))
  }
}
