export interface BrowserWorkspaceController {
  openPanel(panelId: string, options?: { reuseExisting?: boolean }): unknown
  surface(surface: "side"): { close(): void }
}

const AUTO_SHOW_BROWSER_TOOLS = new Set([
  "browser_action",
  "browser_audit",
  "browser_console",
  "browser_dialog",
  "browser_emulate",
  "browser_eval",
  "browser_inspect",
  "browser_navigation",
  "browser_network",
  "browser_performance",
  "browser_read",
  "browser_screenshot",
  "browser_snapshot",
  "browser_upload",
  "browser_wait",
])

export function shouldAutoShowBrowserTool(toolName: string, metadata: Record<string, unknown>): boolean {
  if (!AUTO_SHOW_BROWSER_TOOLS.has(toolName)) return false
  if (typeof metadata.pageId === "string") return true
  const page = metadata.page
  return typeof page === "object" && page !== null && typeof (page as { id?: unknown }).id === "string"
}

export function applyBrowserViewCommand(
  metadata: Record<string, unknown>,
  workspace: BrowserWorkspaceController,
): boolean {
  const command = metadata.workspaceCommand ?? metadata.action
  if (command === "hide") {
    workspace.surface("side").close()
    return true
  }
  if (command === "show" || command === "focus") {
    workspace.openPanel("browser", { reuseExisting: true })
    return true
  }
  return false
}

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
