// Client-side config fields are persisted but not reloaded by the server
// runtime; a save that changes only these fields refreshes the global config
// store instead of triggering a full refreshAllConfigs().
const CLIENT_SIDE_FIELDS = new Set(["theme", "keybinds", "layout", "toast", "locale", "defaultSessionWorkspace"])

export type ConfigUpdatedProperties = {
  scope: "global" | "project"
  changedFields: string[]
}

export function shouldRefreshGlobalConfig(properties: ConfigUpdatedProperties): boolean {
  return (
    properties.scope === "global" &&
    properties.changedFields.length > 0 &&
    properties.changedFields.every((field) => CLIENT_SIDE_FIELDS.has(field))
  )
}
