import "./builtin-navigation"

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
  type SettingsSection,
  registerSettingsSection,
  getSettingsSections,
  getSettingsSection,
} from "./registries/settings-registry"

export {
  type PluginThemeDefinition,
  registerPluginTheme,
  listPluginThemes,
  getPluginTheme,
  subscribePluginThemes,
} from "@ericsanchezok/synergy-ui/theme"

export { type IconEntry, registerIcon, getIcon, hasIcon, listIcons } from "./registries/icon-registry"

export {
  type ComposerSlotName,
  type ComposerSlotProps,
  type ComposerSlotEntry,
  registerComposerSlot,
  getComposerSlotsByName,
  clearComposerSlots,
  subscribeComposerSlots,
} from "./registries/composer-slot-registry"

export {
  type NavigationPlacement,
  type NavigationContentProps,
  type NavigationEntry,
  registerNavigation,
  listNavigation,
  navigationEntryLabel,
  getNavigation,
  getPluginNavigation,
  getBuiltinNavigation,
  getNavigationByPath,
  clearNavigation,
  subscribeNavigation,
} from "./registries/navigation-registry"

export { type PartRenderer, registerPartRenderer, getPartRenderer, hasPartRenderer } from "./registries/part-registry"
export { type PluginContribution } from "./api"
export { loadPluginExport, isCompatibleUIVersion, CURRENT_UI_API_VERSION } from "./loaders"
export { PluginComposerSlotBridge, PluginThemeConfigBridge } from "./bridge"
export { PluginErrorBoundary } from "./components/plugin-error-boundary"
export { initDevReload } from "./dev-reload"
export { PluginHostProvider, usePluginHost, type PluginUIStatus, type PluginUIError } from "./host"
export { PluginRouteScope } from "./route-scope"
export { resolvePluginScopeKey } from "./scope-key"
export { fetchUIContributions } from "./api"
export { BuiltinNavigationPage, PluginNavigationPage } from "./pages"

// Consent UI components
export { PermissionRiskBadge, PluginConsentDialog } from "./consent"
export type {
  PermissionItem,
  PermissionSeverity,
  PermissionChange,
  PluginPermissionDiff,
  PluginConsentDialogProps,
} from "./consent"
