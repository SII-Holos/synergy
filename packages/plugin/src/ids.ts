export namespace PluginToolId {
  export function format(pluginId: string, toolId: string): string {
    return `plugin__${pluginId}__${toolId}`
  }

  export function parse(id: string): { pluginId: string; toolId: string } | undefined {
    const match = id.match(/^plugin__([^_]+(?:_[^_]+)*?)__([^_].*)$/)
    if (!match) return undefined
    return { pluginId: match[1], toolId: match[2] }
  }

  export function is(id: string): boolean {
    return id.startsWith("plugin__")
  }
}

export namespace PluginId {
  export function isValid(id: string): boolean {
    return /^[a-z][a-z0-9_-]*$/i.test(id)
  }

  export function normalize(id: string): string {
    return id.trim().toLowerCase()
  }

  export function mcpServerKey(pluginId: string, serverKey: string): string {
    return `${pluginId}::${serverKey}`
  }
}
