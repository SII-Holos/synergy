export function reasoningItemKey(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return
  let identity: string | undefined
  for (const [provider, value] of Object.entries(metadata)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("itemId" in value)) continue
    const itemID = value.itemId
    if (typeof itemID !== "string" || !itemID.trim() || itemID.length > 1024 || provider.length > 128) continue
    if (identity) return
    identity = JSON.stringify([provider, itemID])
  }
  return identity
}
