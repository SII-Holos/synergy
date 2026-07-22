export interface PluginSurfaceIdentity {
  kind: string
  id: string
  resource?: { id: string; title?: string; state?: unknown }
}

export interface PluginUIOperations {
  query<Output = unknown>(id: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<Output>
  command<Output = unknown>(id: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<Output>
}

export interface PluginUIEvents {
  subscribe(eventId: string, listener: (event: unknown) => void): () => void
}

export interface PluginUIHostActions {
  openSession(sessionId: string): void
  openPluginPage(path: string, params?: Record<string, string>): void
  openWorkbenchPanel(panelId: string, resource?: { id: string; title?: string; state?: unknown }): void
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
  settings: {
    get(): Promise<Record<string, unknown>>
    subscribe(listener: (values: Record<string, unknown>) => void): () => void
  }
  host: PluginUIHostActions
}

export interface PluginTextRange {
  start: number
  end: number
}

export interface PluginComposerDocumentSnapshot {
  revision: number
  text: string
  selection: PluginTextRange
  sessionId?: string
  mode: "normal" | "shell"
}

export interface PluginComposerEdit {
  range: PluginTextRange
  text: string
}

export interface PluginComposerCompletion {
  revision: number
  position: number
  text: string
}

export interface PluginComposerDecoration {
  id: string
  range: PluginTextRange
  severity: "info" | "warning" | "error"
  message?: string
  replacement?: string
}

export interface PluginComposerService {
  current(): PluginComposerDocumentSnapshot
  onDraftSettled(
    listener: (snapshot: PluginComposerDocumentSnapshot, context: { signal: AbortSignal }) => void | Promise<void>,
  ): () => void
  onBeforeSubmit(
    listener: (snapshot: PluginComposerDocumentSnapshot, context: { signal: AbortSignal }) => Promise<void>,
  ): () => void
  setCompletion(completion: PluginComposerCompletion | undefined): void
  setDecorations(input: { revision: number; items: PluginComposerDecoration[] }): void
  applyEdits(input: { revision: number; edits: PluginComposerEdit[] }): Promise<PluginComposerDocumentSnapshot>
}

export interface PluginComposerSurfaceContext extends PluginSurfaceContext {
  composer: PluginComposerService
}

export interface TextSelectionSnapshot {
  text: string
}

export interface PluginSelectionService {
  current(): TextSelectionSnapshot | undefined
  onSettled(listener: (snapshot: TextSelectionSnapshot | undefined) => void): () => void
}

export interface PluginSelectionSurfaceContext extends PluginSurfaceContext {
  selection: PluginSelectionService
}

export interface PluginMessageSurfaceContext extends PluginSurfaceContext {
  message: {
    id: string
    role: "user" | "assistant"
  }
}
