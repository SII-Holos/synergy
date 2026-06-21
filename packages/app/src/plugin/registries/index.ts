export {
  type WorkspacePanelEntry,
  registerWorkspacePanel,
  listWorkspacePanels,
  clearWorkspacePanels,
} from "./workspace-registry"

export { type GlobalPanelEntry, registerGlobalPanel, listGlobalPanels, clearGlobalPanels } from "./panel-registry"

export { type SettingsSection, registerSettingsSection, getSettingsSections } from "./settings-registry"

export {
  type ThemeDefinition,
  registerTheme,
  listThemes,
  getTheme,
  activateTheme,
  getActiveThemeId,
  getActiveTheme,
} from "./theme-registry"

export { type IconEntry, registerIcon, getIcon, hasIcon, listIcons } from "./icon-registry"

export { type ChatSlot, type ChatComponentEntry, registerChatComponent, getChatComponentsBySlot } from "./chat-registry"

export { type PluginRouteEntry, registerPluginRoute, getPluginRoutes, clearPluginRoutes } from "./route-registry"
