export const WORKSPACE_DEFAULT_WIDTH = 640
export const WORKSPACE_MIN_WIDTH = 360
export const WORKSPACE_SESSION_MIN_WIDTH = 350
export const WORKSPACE_TABS_MIN_WIDTH = 200

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

// Used before the mounted Shell reports its actual navigation width.
export function sidebarOccupancy(isDesktop: boolean, sidebarOpened: boolean, sidebarWidth: number) {
  if (!isDesktop) return 0
  return sidebarOpened ? sidebarWidth : 0
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
  return clampWorkspaceWidth(Math.min(720, Math.round(viewportWidth * 0.5)), viewportWidth, constraints)
}

export function workspacePresentation(availableWidth: number, preferredWidth: number, fullscreen: boolean) {
  const automatic = availableWidth < WORKSPACE_MIN_WIDTH + WORKSPACE_SESSION_MIN_WIDTH
  const overlay = fullscreen || automatic
  return { overlay, automatic, width: overlay ? availableWidth : clampWorkspaceWidth(preferredWidth, availableWidth) }
}

export function workspaceNavigatorWidth(resourceWidth: number, preferredWidth: number) {
  const drawer = resourceWidth < 520
  const width = Math.max(208, Math.min(420, preferredWidth, drawer ? resourceWidth - 24 : resourceWidth - 280))
  return { drawer, width }
}
