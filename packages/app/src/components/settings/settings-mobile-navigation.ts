export interface SettingsMobileNavigationState {
  activeTab: string
  detailOpen: boolean
  desktop: boolean
}

export type SettingsMobileNavigationAction =
  | { type: "select"; id: string }
  | { type: "back" }
  | { type: "layout"; desktop: boolean }
  | { type: "validate"; sectionIDs: readonly string[] }

export function createSettingsMobileNavigationState(
  initialTab: string,
  sectionIDs: readonly string[],
  desktop: boolean,
): SettingsMobileNavigationState {
  const activeTab = sectionIDs.includes(initialTab) ? initialTab : "general"
  return {
    activeTab,
    detailOpen: activeTab !== "general",
    desktop,
  }
}

export function reduceSettingsMobileNavigation(
  state: SettingsMobileNavigationState,
  action: SettingsMobileNavigationAction,
): SettingsMobileNavigationState {
  if (action.type === "select") {
    return {
      ...state,
      activeTab: action.id,
      detailOpen: state.desktop ? state.detailOpen : true,
    }
  }
  if (action.type === "back") {
    return state.detailOpen ? { ...state, detailOpen: false } : state
  }
  if (action.type === "layout") {
    if (state.desktop === action.desktop) return state
    return {
      ...state,
      desktop: action.desktop,
      detailOpen: state.desktop && !action.desktop ? false : state.detailOpen,
    }
  }
  if (action.sectionIDs.includes(state.activeTab)) return state
  return {
    ...state,
    activeTab: "general",
    detailOpen: false,
  }
}
