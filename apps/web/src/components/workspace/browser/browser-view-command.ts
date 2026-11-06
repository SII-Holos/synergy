export interface BrowserNavigationRequest {
  url: string
  nonce: number
}

export function browserNavigationRequestFromTabState(state: unknown): BrowserNavigationRequest | undefined {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined
  const record = state as Record<string, unknown>
  if (typeof record.url !== "string" || record.url.length === 0) return undefined
  if (typeof record.nonce !== "number") return undefined
  return { url: record.url, nonce: record.nonce }
}

export function resolvePendingBrowserNavigation(
  tabState: unknown,
  handledNonce: number | undefined,
): BrowserNavigationRequest | undefined {
  const request = browserNavigationRequestFromTabState(tabState)
  return request && request.nonce !== handledNonce ? request : undefined
}
