export interface PluginSurfaceIdentity {
  kind: string
  id: string
}

export interface PluginUIOperations {
  query<Output = unknown>(id: string, input?: unknown): Promise<Output>
  command<Output = unknown>(id: string, input?: unknown): Promise<Output>
}

export interface PluginUIEvents {
  subscribe(eventId: string, listener: (event: unknown) => void): () => void
}

export interface PluginUIHostActions {
  openSession(sessionId: string): void
  openPluginPage(path: string, params?: Record<string, string>): void
  openWorkbenchPanel(panelId: string, resource?: { id?: string; title?: string; state?: unknown }): void
  openResource(resource: { kind: "artifact" | "file"; uri: string }): void
  notify(message: string, options?: { kind?: "info" | "success" | "warning" | "error" }): void
  confirm(options: { title: string; message: string; confirmLabel?: string }): Promise<boolean>
}

export interface PluginSurfaceContext {
  pluginId: string
  scopeId: string
  sessionId?: string
  surface: PluginSurfaceIdentity
  operations: PluginUIOperations
  events: PluginUIEvents
  host: PluginUIHostActions
}
