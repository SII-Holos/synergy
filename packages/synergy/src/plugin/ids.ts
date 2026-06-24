export namespace PluginToolId {
  /** Format a plugin tool ID string: plugin__pluginId__toolId */
  export function format(pluginId: string, toolId: string): string {
    return `plugin__${pluginId}__${toolId}`
  }

  /** Parse a plugin tool ID string, returning { pluginId, toolId } or undefined */
  export function parse(id: string): { pluginId: string; toolId: string } | undefined {
    const m = id.match(/^plugin__([^_]+(?:_[^_]+)*?)__([^_].*)$/)
    if (!m) return undefined
    return { pluginId: m[1], toolId: m[2] }
  }

  /** Check if a string is a plugin tool ID (starts with plugin__) */
  export function is(id: string): boolean {
    return id.startsWith("plugin__")
  }
}

export namespace PluginId {
  /** Check if a string is a valid plugin id (alphanumeric + dash/underscore) */
  export function isValid(id: string): boolean {
    return /^[a-z][a-z0-9_-]*$/i.test(id)
  }

  /** Normalize a plugin id: lowercase, trim */
  export function normalize(id: string): string {
    return id.trim().toLowerCase()
  }

  /** Format a namespaced MCP server key: pluginId::serverKey */
  export function mcpServerKey(pluginId: string, serverKey: string): string {
    return `${pluginId}::${serverKey}`
  }
}
