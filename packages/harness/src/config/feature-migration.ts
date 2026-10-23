import path from "node:path"
import { readFile } from "node:fs/promises"
import { applyEdits, modify } from "jsonc-parser"
import { FEATURE_CONFIG_FILENAME, parseFeatureConfig } from "@ericsanchezok/synergy-util/feature-config"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"

export async function retireFeaturePreferences(configDirectory: string, retired: readonly string[]) {
  const filename = path.join(configDirectory, "synergy.d", FEATURE_CONFIG_FILENAME)
  const raw = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined) return false
  const preferences = parseFeatureConfig(raw)
  const optIn = preferences.optIn.filter((id) => !retired.includes(id))
  if (optIn.length === preferences.optIn.length) return false
  const text = applyEdits(
    raw,
    modify(raw, ["features", "optIn"], optIn, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }),
  )
  await AtomicFile.writeFileAtomic(filename, text, { private: true, durable: true })
  return true
}
