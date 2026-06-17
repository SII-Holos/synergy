export function assetHttpUrl(baseUrl: string, asset: { id?: string; url?: string } | undefined) {
  if (!asset) return ""
  if (asset.url && !asset.url.startsWith("asset://")) return asset.url

  const id = asset.id ?? (asset.url?.startsWith("asset://") ? asset.url.slice("asset://".length) : undefined)
  if (!id) return asset.url ?? ""

  const normalizedBase = baseUrl.replace(/\/$/, "")
  return `${normalizedBase}/asset/${encodeURIComponent(id)}`
}
