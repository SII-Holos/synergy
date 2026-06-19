export const WORKSPACE_DEFAULT_WIDTH = 640
export const WORKSPACE_MIN_WIDTH = 300
export const WORKSPACE_SESSION_MIN_WIDTH = 350
export const WORKSPACE_TABS_MIN_WIDTH = 200
export const WORKSPACE_RAIL_GAP = 8
export const WORKSPACE_RAIL_VISIBLE_MARGIN = 60

export interface WorkspaceWidthConstraints {
  sessionMinWidth?: number
  tabsMinWidth?: number
}

export function computeMaxWorkspaceWidth(viewportWidth: number, constraints: WorkspaceWidthConstraints = {}) {
  const sessionMinWidth = constraints.sessionMinWidth ?? WORKSPACE_SESSION_MIN_WIDTH
  const tabsMinWidth = constraints.tabsMinWidth ?? 0
  return Math.max(WORKSPACE_MIN_WIDTH, viewportWidth - sessionMinWidth - tabsMinWidth)
}

export function clampWorkspaceWidth(width: number, viewportWidth: number, constraints: WorkspaceWidthConstraints = {}) {
  return Math.max(WORKSPACE_MIN_WIDTH, Math.min(width, computeMaxWorkspaceWidth(viewportWidth, constraints)))
}

export function computeWorkspaceRailRight(workspaceWidth: number, viewportWidth: number) {
  return Math.min(
    workspaceWidth + WORKSPACE_RAIL_GAP,
    Math.max(WORKSPACE_RAIL_GAP, viewportWidth - WORKSPACE_RAIL_VISIBLE_MARGIN),
  )
}

export function computeDefaultWorkspaceWidth(viewportWidth: number, constraints: WorkspaceWidthConstraints = {}) {
  const sessionMinWidth = constraints.sessionMinWidth ?? WORKSPACE_SESSION_MIN_WIDTH
  const remaining = viewportWidth - sessionMinWidth
  // 3/5 of the remaining space, but not below WORKSPACE_MIN_WIDTH
  return Math.max(WORKSPACE_MIN_WIDTH, Math.round(remaining * 0.6))
}
