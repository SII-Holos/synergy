import { generateRandomBytes } from "@ericsanchezok/synergy-util/uuid"

export type WelcomeSelection = { sceneId: string; seed: number; previousId?: string }
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

function random() {
  return new DataView(generateRandomBytes(4).buffer).getUint32(0) / 0x100000000
}

export function createWelcomeSelection(options: { ids: readonly string[]; storage?: Storage; random?: () => number }) {
  const ids = [...new Set(options.ids)]
  if (!ids.length) throw new Error("At least one welcome scene is required")
  const records = new Map<string, WelcomeSelection>()
  const draw = options.random ?? random
  const key = (connection: string) => `synergy-welcome-v1:${encodeURIComponent(connection)}`
  function save(connection: string, record: WelcomeSelection) {
    records.set(connection, record)
    try {
      options.storage?.setItem(key(connection), JSON.stringify(record))
    } catch {}
    return record
  }
  function choose(connection: string, previousId?: string) {
    const candidates = ids.length > 1 ? ids.filter((id) => id !== previousId) : ids
    return save(connection, {
      sceneId: candidates[Math.min(candidates.length - 1, Math.floor(draw() * candidates.length))]!,
      seed: Math.floor(draw() * 0x100000000),
      ...(previousId ? { previousId } : {}),
    })
  }
  function current(connection: string): WelcomeSelection {
    const cached = records.get(connection)
    if (cached) return cached
    try {
      const value: unknown = JSON.parse(options.storage?.getItem(key(connection)) ?? "null")
      if (
        value &&
        typeof value === "object" &&
        "sceneId" in value &&
        "seed" in value &&
        typeof value.sceneId === "string" &&
        ids.includes(value.sceneId) &&
        typeof value.seed === "number" &&
        Number.isInteger(value.seed) &&
        value.seed >= 0 &&
        value.seed < 0x100000000
      ) {
        const record: WelcomeSelection = { sceneId: value.sceneId, seed: value.seed }
        if ("previousId" in value && typeof value.previousId === "string") record.previousId = value.previousId
        records.set(connection, record)
        return record
      }
    } catch {}
    return choose(connection)
  }
  return { current, begin: (connection: string) => choose(connection, current(connection).sceneId) }
}
