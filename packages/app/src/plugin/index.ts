export {
  type WorkspacePanelEntry,
  registerWorkspacePanel,
  listWorkspacePanels,
  clearWorkspacePanels,
} from "./registries/workspace-registry"

export {
  type GlobalPanelEntry,
  registerGlobalPanel,
  listGlobalPanels,
  clearGlobalPanels,
} from "./registries/panel-registry"

export { type SettingsSection, registerSettingsSection, getSettingsSections } from "./registries/settings-registry"

export {
  type ThemeDefinition,
  registerTheme,
  listThemes,
  getTheme,
  activateTheme,
  getActiveThemeId,
  getActiveTheme,
} from "./registries/theme-registry"

export { type IconEntry, registerIcon, getIcon, hasIcon, listIcons } from "./registries/icon-registry"

export {
  type ChatSlot,
  type ChatComponentEntry,
  registerChatComponent,
  getChatComponentsBySlot,
} from "./registries/chat-registry"

export {
  type PluginRouteEntry,
  registerPluginRoute,
  getPluginRoutes,
  clearPluginRoutes,
} from "./registries/route-registry"
