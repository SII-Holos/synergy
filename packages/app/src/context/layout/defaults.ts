export const SIDEBAR_WIDTH_DEFAULT = 300
export const SIDEBAR_WIDTH_MIN = 220
export const SIDEBAR_WIDTH_MAX = 420
export const SIDEBAR_COLLAPSE_THRESHOLD = 230

export function clampSidebarWidth(width: number) {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)))
}

export function effectiveSidebarWidth(state: { width?: number; resized?: boolean } | undefined) {
  if (state?.resized !== true || typeof state.width !== "number" || !Number.isFinite(state.width)) {
    return SIDEBAR_WIDTH_DEFAULT
  }
  return clampSidebarWidth(state.width)
}

export function createInitialLayoutDefaults() {
  return {
    sidebar: {
      opened: true,
      width: SIDEBAR_WIDTH_DEFAULT,
      resized: false,
    },
    mobileSidebar: {
      opened: false,
    },
    rightSidebar: {
      opened: false,
    },
  }
}
