import { z } from "zod"
import { ContextUsageSchema } from "./context-usage-schema"

const LegacyCategory = z.object({
  estimatedTokens: z.number().int().nonnegative(),
  attributedTokens: z.number().int().nonnegative(),
  items: z.number().int().nonnegative().optional(),
})
const Legacy = ContextUsageSchema.extend({
  version: z.literal(1),
  categories: z.object({
    conversation: LegacyCategory,
    toolActivity: LegacyCategory,
    filesReferences: LegacyCategory,
    instructions: LegacyCategory,
  }),
})
export function upgradeContextUsage(record: Record<string, unknown>) {
  if (record.role !== "assistant") return false
  const parsed = Legacy.safeParse(record.contextUsage)
  if (!parsed.success) return false
  const value = parsed.data
  record.contextUsage = ContextUsageSchema.parse({
    ...value,
    version: 2,
    categories: [
      { category: "legacyConversation", precision: "legacy", ...value.categories.conversation },
      { category: "legacyTools", precision: "legacy", ...value.categories.toolActivity },
      { category: "attachments", precision: "legacy", ...value.categories.filesReferences },
      { category: "legacyInstructions", precision: "legacy", ...value.categories.instructions },
    ],
  })
  return true
}
export function upgradeContextUsageRecord(key: string[], value: Record<string, unknown>) {
  if (key[0] === "sessions" && key.length === 6 && key[3] === "messages" && key[5] === "info")
    upgradeContextUsage(value)
}
export async function migrateContextUsage(
  owner: { scopeID: string; sessionID: string },
  progress: (current: number, total: number) => void,
) {
  const [{ Storage }, { UpgradeWork }] = await Promise.all([
    import("../storage/storage"),
    import("../storage/upgrade-work"),
  ])
  let done = 0
  for await (const entry of Storage.records<Record<string, unknown>>({ kind: "message", ...owner })) {
    await UpgradeWork.checkpoint()
    const value = structuredClone(entry.value)
    if (upgradeContextUsage(value)) await Storage.write(entry.key, value)
    progress(++done, 0)
  }
  progress(done, done)
}
