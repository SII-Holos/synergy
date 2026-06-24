export interface RuntimeDiscoveryInput {
  manifestToolNames: string[]
  runtimeToolNames: string[] | null
  pluginId: string
}

export interface RuntimeDiscoveryResult {
  matched: string[]
  undeclared: string[]
  declaredButMissing: string[]
  loadFailed: boolean
}

export function validateRuntimeDiscovery(input: RuntimeDiscoveryInput): RuntimeDiscoveryResult {
  if (input.runtimeToolNames === null) {
    return { matched: [], undeclared: [], declaredButMissing: input.manifestToolNames, loadFailed: true }
  }

  const manifestTools = new Set(input.manifestToolNames)
  const runtimeTools = new Set(input.runtimeToolNames)
  return {
    matched: input.runtimeToolNames.filter((tool) => manifestTools.has(tool)),
    undeclared: input.runtimeToolNames.filter((tool) => !manifestTools.has(tool)),
    declaredButMissing: input.manifestToolNames.filter((tool) => !runtimeTools.has(tool)),
    loadFailed: false,
  }
}
