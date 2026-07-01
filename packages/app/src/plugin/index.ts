export {
  type WorkbenchPanelEntry,
  type WorkbenchPanelSurface,
  type WorkbenchPanelCardinality,
  type WorkbenchPanelTab,
  registerWorkbenchPanel,
  listWorkbenchPanels,
  getWorkbenchPanel,
  clearWorkbenchPanels,
  subscribeWorkbenchPanels,
} from "./registries/workbench-panel-registry"

export {
  type GlobalPanelEntry,
  registerGlobalPanel,
  listGlobalPanels,
  getGlobalPanel,
  clearGlobalPanels,
} from "./registries/panel-registry"

export {
  type SettingsSection,
  registerSettingsSection,
  getSettingsSections,
  getSettingsSection,
} from "./registries/settings-registry"

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

export {
  type PluginCommandEntry,
  registerPluginCommand,
  listPluginCommands,
  getPluginCommand,
  clearPluginCommands,
} from "./registries/command-registry"

export {
  ToolRendererRegistry,
  toolRendererRegistry,
  type ToolRendererEntry,
  type ToolFallbackMeta,
  type ToolRendererProps,
  type ToolRenderer,
  registerToolRenderer,
  getToolRenderer,
  getToolFallback,
  hasToolRenderer,
  onToolLoaded,
  clearAllToolRenderers,
} from "./registries/tool-registry"
export { type PartRenderer, registerPartRenderer, getPartRenderer, hasPartRenderer } from "./registries/part-registry"
export { type PluginContribution, type PluginUIContributions, type PluginPermissions } from "./api"
export { loadPluginExport, isCompatibleUIVersion, CURRENT_UI_API_VERSION } from "./loaders"
export { PluginToolBridge } from "./bridge"
export { PluginErrorBoundary } from "./components/plugin-error-boundary"
export { initDevReload } from "./dev-reload"
export { PluginHostProvider, usePluginHost, type PluginUIStatus, type PluginUIError } from "./host"
export { fetchUIContributions } from "./api"

// Consent UI components
export { PermissionDiffList, PermissionRiskBadge, TrustTierExplanation, InstallConsentDialog } from "./consent"
export type { PermissionItem, PermissionSeverity, PermissionChange, PluginPermissionDiff, TrustTier } from "./consent"

// Marketplace components
export { VerifiedBadge, MarketplacePage, PluginDetailPage } from "./marketplace"
