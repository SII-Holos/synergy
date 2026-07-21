export interface PluginCapability {
  id: string
  constraints?: Record<string, unknown>
}

export function capability(id: string, constraints?: Record<string, unknown>): PluginCapability {
  return constraints ? { id, constraints } : { id }
}
