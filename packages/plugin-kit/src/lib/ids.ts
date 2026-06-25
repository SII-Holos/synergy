export namespace PluginId {
  export function isValid(id: string): boolean {
    return /^[a-z0-9][a-z0-9-]*$/.test(id)
  }
}
