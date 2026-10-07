import type { StorageSessionPreparation } from "@ericsanchezok/synergy-sdk/client"

export function createSessionPreparationCache(limit = 30) {
  const entries = new Map<string, StorageSessionPreparation>()
  const key = (server: string, sessionID: string) => JSON.stringify([server, sessionID])
  return {
    get(server: string, sessionID: string) {
      const id = key(server, sessionID)
      const value = entries.get(id)
      if (value) {
        entries.delete(id)
        entries.set(id, value)
      }
      return value
    },
    set(server: string, value: StorageSessionPreparation) {
      const id = key(server, value.sessionID)
      entries.delete(id)
      if (value.state !== "ready") return
      entries.set(id, value)
      while (entries.size > limit) entries.delete(entries.keys().next().value!)
    },
    clear() {
      entries.clear()
    },
  }
}
