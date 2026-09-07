export const PLUGIN_PAGE_IDS = [
  "session",
  "agenda",
  "kanban",
  "library",
  "performance",
  "plugins",
  "plugin-detail",
  "plugin-page",
] as const

export type PluginPageId = (typeof PLUGIN_PAGE_IDS)[number]

export const PLUGIN_EXTENSIONS = {
  "settings.section": { context: "scope", cardinality: "multiple", responsibility: "settings", required: false },
  "sidebar.footer": { context: "scope", cardinality: "multiple", responsibility: "column", required: false },
  "session.header.actions": { context: "session", cardinality: "multiple", responsibility: "toolbar", required: false },
  "session.empty": { context: "session", cardinality: "multiple", responsibility: "column", required: false },
  "app.footer": { context: "scope", cardinality: "multiple", responsibility: "toolbar", required: true },
  "message.before": { context: "message", cardinality: "multiple", responsibility: "column", required: false },
  "message.after": { context: "message", cardinality: "multiple", responsibility: "column", required: false },
  "message.actions": { context: "message", cardinality: "multiple", responsibility: "toolbar", required: false },
  "composer.above": { context: "session", cardinality: "multiple", responsibility: "column", required: false },
  "composer.below": { context: "session", cardinality: "multiple", responsibility: "column", required: false },
  "composer.toolbar.left": { context: "session", cardinality: "multiple", responsibility: "toolbar", required: false },
  "composer.toolbar.right": { context: "session", cardinality: "multiple", responsibility: "toolbar", required: false },
  "composer.add-menu": { context: "session", cardinality: "multiple", responsibility: "menu", required: false },
  "composer.start-option": { context: "session", cardinality: "multiple", responsibility: "menu", required: false },
  "navigation.sidebar": { context: "scope", cardinality: "multiple", responsibility: "navigation", required: false },
  "navigation.page": { context: "scope", cardinality: "single", responsibility: "page", required: false },
  "workbench.side": { context: "resource", cardinality: "multiple", responsibility: "tabs", required: false },
  "workbench.bottom": { context: "resource", cardinality: "multiple", responsibility: "tabs", required: false },
} as const
export type PluginExtensionId = keyof typeof PLUGIN_EXTENSIONS
export type PluginComposerSlot = Extract<PluginExtensionId, `composer.${string}`>
export type PluginMessageSlot = Extract<PluginExtensionId, `message.${string}`>
export type PluginGenericSlot = Exclude<
  PluginExtensionId,
  PluginComposerSlot | PluginMessageSlot | `navigation.${string}` | `workbench.${string}`
>
export const PLUGIN_GENERIC_SLOTS = Object.keys(PLUGIN_EXTENSIONS).filter(
  (id): id is PluginGenericSlot => !/^(composer|message|navigation|workbench)\./.test(id),
)
export const PLUGIN_MENU_LOCATIONS = ["app.footer", "session.header.actions", "composer.toolbar.right"] as const
export type PluginMenuLocation = (typeof PLUGIN_MENU_LOCATIONS)[number]

export const PLUGIN_EXTENSION_CATALOG = (Object.keys(PLUGIN_EXTENSIONS) as PluginExtensionId[]).map((id) => ({
  id,
  ...PLUGIN_EXTENSIONS[id],
  platforms: ["web", "desktop"] as const,
  ordering: "order-label-id" as const,
  collision: "reject-duplicate-owner-id" as const,
  focus: "contribution-controls-host-navigation" as const,
  overflow: PLUGIN_EXTENSIONS[id].responsibility === "toolbar" ? ("host-wrap" as const) : ("host-scroll" as const),
}))
