import type { RolloutSchema } from "./schema"

export async function readRolloutRevision(owner: RolloutSchema.Owner): Promise<number> {
  const { RolloutJournal } = await import("./journal")
  return (await RolloutJournal.head(owner)).committed
}
