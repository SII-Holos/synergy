export interface BrowserProfileInput {
  sessionID: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
}

export function browserProfilePartition(input: BrowserProfileInput): string {
  const ownerKey = input.scopeID ?? input.routeDirectory ?? input.directory ?? input.scopeKey ?? "default"
  const raw = `${input.sessionID}:${ownerKey}`
  return `persist:synergy-browser-${Buffer.from(raw).toString("base64url")}`
}
