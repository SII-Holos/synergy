export const WORKSPACE_DEFAULT_WIDTH = 640
export const WORKSPACE_MIN_WIDTH = 300
export const WORKSPACE_SESSION_MIN_WIDTH = 350
export const WORKSPACE_TABS_MIN_WIDTH = 200
export const SIDEBAR_RAIL_WIDTH = 48

export interface WorkspaceWidthConstraints {
  sessionMinWidth?: number
  tabsMinWidth?: number
}

export function sessionSideWorkspaceMounts(isDesktop: boolean, sideOpen: boolean) {
  return {
    desktop: isDesktop,
    mobile: !isDesktop && sideOpen,
  }
}

// Horizontal space the global sidebar takes from the main session area: the
// persisted width when expanded, the fixed icon rail when collapsed, and none
// on mobile where navigation is a modal drawer.
export function sidebarOccupancy(isDesktop: boolean, sidebarOpened: boolean, sidebarWidth: number) {
  if (!isDesktop) return 0
  return sidebarOpened ? sidebarWidth : SIDEBAR_RAIL_WIDTH
}

export function computeMaxWorkspaceWidth(viewportWidth: number, constraints: WorkspaceWidthConstraints = {}) {
  const sessionMinWidth = constraints.sessionMinWidth ?? WORKSPACE_SESSION_MIN_WIDTH
  const tabsMinWidth = constraints.tabsMinWidth ?? 0
  return Math.max(WORKSPACE_MIN_WIDTH, viewportWidth - sessionMinWidth - tabsMinWidth)
}

export function clampWorkspaceWidth(width: number, viewportWidth: number, constraints: WorkspaceWidthConstraints = {}) {
  return Math.max(WORKSPACE_MIN_WIDTH, Math.min(width, computeMaxWorkspaceWidth(viewportWidth, constraints)))
}

export function computeDefaultWorkspaceWidth(viewportWidth: number, constraints: WorkspaceWidthConstraints = {}) {
  return clampWorkspaceWidth(Math.round(viewportWidth * 0.5), viewportWidth, constraints)
}
