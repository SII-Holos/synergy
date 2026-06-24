export interface BrowserWorkspaceController {
  setActive(id: string | null): void
  openPanel(): void
  closePanel(): void
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
