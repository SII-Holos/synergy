export type ConfigUpdatedProperties = {
  scope: "global" | "project"
  changedFields: string[]
}

export function shouldRefreshGlobalConfig(properties: ConfigUpdatedProperties): boolean {
  return properties.scope === "global" && properties.changedFields.includes("locale")
}
