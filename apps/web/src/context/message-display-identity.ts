export function createMessageDisplayIdentity() {
  const aliases = new Map<string, string>()
  const key = (owner: readonly string[], id: string) => JSON.stringify([...owner, id])
  return {
    key: (owner: readonly string[], id: string) => aliases.get(key(owner, id)) ?? id,
    handoff(owner: readonly string[], optimisticID: string, canonicalID: string) {
      if (optimisticID === canonicalID) return
      aliases.set(key(owner, canonicalID), aliases.get(key(owner, optimisticID)) ?? optimisticID)
      while (aliases.size > 64) aliases.delete(aliases.keys().next().value!)
    },
  }
}
