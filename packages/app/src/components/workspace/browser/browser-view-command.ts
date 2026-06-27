export interface BrowserWorkspaceController {
  setActive(id: string | null): void
  openPanel(): void
  closePanel(): void
}

const AUTO_SHOW_BROWSER_TOOLS = new Set([
  "browser_action",
  "browser_click",
  "browser_console",
  "browser_eval",
  "browser_inspect",
  "browser_navigate",
  "browser_network",
  "browser_read",
  "browser_screenshot",
  "browser_scroll",
  "browser_snapshot",
  "browser_type",
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
    workspace.closePanel()
    return true
  }
  if (command === "show" || command === "focus") {
    workspace.setActive("browser")
    workspace.openPanel()
    return true
  }
  return false
}
