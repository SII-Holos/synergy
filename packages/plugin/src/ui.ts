import type { PluginComposerLayoutService } from "./composer-layout.js"
import type { PluginConversationService } from "./conversation.js"
import type { PluginUICondition } from "./ui-condition.js"
import type { PluginMenuLocation } from "./ui-catalog.js"
import type { PluginTextSelectionSnapshot } from "./contribution.js"
import type { JSX } from "solid-js"
import type { Session, Message, Part, SessionStatus } from "@ericsanchezok/synergy-sdk"
import type { PluginPageId } from "./ui-catalog.js"

export interface PluginComponentProps<C extends object = PluginSurfaceContext> {
  context: C
}

export type PluginHostViewId =
  | "navigation"
  | "route"
  | "footer"
  | "conversation"
  | "composer"
  | "workbench.side"
  | "workbench.bottom"

export interface PluginShellService {
  page(): PluginPageId
  render(view: PluginHostViewId): JSX.Element
}

export interface PluginShellContext extends PluginSurfaceContext {
  shell: PluginShellService
  session?: PluginSessionService
  conversation?: PluginConversationService
  composerLayout?: PluginComposerLayoutService
  layout?: PluginSessionLayoutService
  input?: PluginInputService
}

export type PluginReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: PluginReadonly<T[K]> }
    : T

export interface PluginSessionCollection {
  list(): readonly PluginReadonly<Session>[]
  get(id: string): PluginReadonly<Session> | undefined
  total(): number
  ready(): boolean
  refresh(): Promise<void>
}

export interface PluginSessionService {
  current(): PluginReadonly<Session> | undefined
  messages(): readonly PluginReadonly<Message>[]
  message(id: string): PluginReadonly<Message> | undefined
  parts(messageId: string): readonly PluginReadonly<Part>[]
  status(): PluginReadonly<SessionStatus>
  ready(): boolean
  history(): { mode: "latest" | "history"; loading: boolean; more: boolean; pendingLatest: boolean }
  loadEarlier(): Promise<void>
  returnLatest(): Promise<void>
  refresh(): Promise<void>
  rewind(messageId: string): void
  fork(messageId: string): void
}

export interface PluginSessionLayoutService {
  minimumWidth(): number | undefined
  promptHeight(): number | undefined
  render(part: "conversation" | "composer" | "workbench.side" | "workbench.bottom"): JSX.Element
}

export interface PluginUILifetime {
  readonly signal: AbortSignal
  onDispose(cleanup: () => void): () => void
}

export interface PluginSurfaceIdentity {
  kind: string
  id: string
  resource?: { id: string; title?: string; state?: unknown }
}

export type PluginRoute =
  | { page: "session"; sessionId?: string }
  | { page: "plugin-page"; pluginId: string; navigationId: string }
  | { page: "plugin-detail"; pluginId: string }
  | { page: Exclude<PluginPageId, "session" | "plugin-page" | "plugin-detail"> }

export interface PluginUIEnvironment {
  route(): PluginRoute
  scopeKey(): string
  platform(): "web" | "desktop"
  locale(): string
  theme(): { id: string; mode: "light" | "dark" }
  visible(): boolean
  viewport(): { width: number; height: number }
}

export interface PluginUINavigation {
  open(route: PluginRoute, options?: { replace?: boolean }): void
}

export interface PluginUIOperations {
  query<Output = unknown>(id: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<Output>
  command<Output = unknown>(id: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<Output>
}

export interface PluginUIEvents {
  subscribe(eventId: string, listener: (payload: unknown, metadata: PluginUIEventMetadata) => void): () => void
}

export interface PluginUIEventMetadata {
  generation: string
  scopeId: string
  sessionId?: string
  sequence: number
  timestamp: number
}

export interface PluginResourceService {
  open(resource: { kind: "artifact" | "file"; uri: string }): boolean
}

export interface PluginSurfaceContext {
  workbench: PluginWorkbenchService
  resources: PluginResourceService
  sessions: PluginSessionCollection
  lifetime: PluginUILifetime
  environment: PluginUIEnvironment
  navigation: PluginUINavigation
  pluginId: string
  scopeId: string
  sessionId?: string
  surface: PluginSurfaceIdentity
  operations: PluginUIOperations
  events: PluginUIEvents
  settings: {
    get(): Promise<Record<string, unknown>>
    replace(values: Record<string, unknown>): Promise<void>
    subscribe(listener: (values: Record<string, unknown>) => void): () => void
  }
  extensions: PluginUIExtensions
  commands: PluginUICommands
  overlays: PluginUIOverlays
}

export type PluginSettingsSaveStatus = "saved" | "dirty" | "saving" | "error"

export interface PluginSettingsSurfaceContext extends PluginSurfaceContext {
  settings: PluginSurfaceContext["settings"] & {
    values(): Record<string, unknown>
    change(values: Record<string, unknown>): void
    status(): PluginSettingsSaveStatus
  }
}

export type PluginSettingsComponentProps = PluginComponentProps<PluginSettingsSurfaceContext>

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

export type PluginInputViewPart = "leading" | "context" | "toolbar" | "trailing"

export interface PluginInputEditorService {
  label(): string
  mount(element: HTMLDivElement, scroller: HTMLDivElement): () => void
  beforeInput(event: InputEvent): void
  input(): void
  paste(event: ClipboardEvent): Promise<void>
  keyDown(event: KeyboardEvent): void
  completion(): { prefix: string; text: string } | undefined
  placeholder(): string | undefined
}

export interface PluginInputService {
  editor: PluginInputEditorService
  readOnly(): boolean
  composing(): boolean
  primaryAction(): "submit" | "stop"
  current(): PluginComposerDocumentSnapshot
  ready(): boolean
  canSubmit(): boolean
  submitting(): boolean
  stopping(): boolean
  dragging(): boolean
  className(): string | undefined
  applyEdits(input: { revision: number; edits: PluginComposerEdit[] }): Promise<PluginComposerDocumentSnapshot>
  select(range: PluginTextRange): void
  setComposing(composing: boolean): void
  setMode(mode: "normal" | "shell"): void
  submit(): Promise<void>
  stop(): Promise<void>
  attachments(): ReadonlyArray<{ id: string; kind: "attachment" | "note" | "session"; title: string; mime?: string }>
  addAttachments(files: File[]): Promise<void>
  removeAttachment(id: string): void
  agents(): ReadonlyArray<{ id: string; label: string; disabled: boolean }>
  agent(): string | undefined
  selectAgent(id: string): void
  models(): ReadonlyArray<{ providerId: string; modelId: string; label: string }>
  model(): { providerId: string; modelId: string } | undefined
  selectModel(model: { providerId: string; modelId: string } | undefined): void
  variants(): readonly string[]
  variant(): string | undefined
  selectVariant(variant: string | undefined): void
  render(part: PluginInputViewPart): JSX.Element
  dragOver(event: DragEvent): void
  dragLeave(event: DragEvent): void
  drop(event: DragEvent): Promise<void>
}

export interface PluginComposerSurfaceContext extends PluginSurfaceContext {
  composer: PluginComposerService
}

export type TextSelectionSnapshot = PluginTextSelectionSnapshot

export interface PluginSelectionService {
  current(): TextSelectionSnapshot | undefined
  onSettled(listener: (snapshot: TextSelectionSnapshot | undefined) => void): () => void
}

export interface PluginSelectionSurfaceContext extends PluginSurfaceContext {
  selection: PluginSelectionService
}

export interface PluginTextActionSurfaceContext extends PluginSurfaceContext {
  textAction: {
    invocationId: string
    selection: PluginTextSelectionSnapshot
    output: unknown
    close(): void
  }
}

export interface PluginMessageSurfaceContext extends PluginSurfaceContext {
  message: {
    id: string
    role: "user" | "assistant"
  }
}

export interface PluginToolMessageSurfaceContext extends PluginMessageSurfaceContext {
  tool: {
    name: string
    input: Record<string, unknown>
    metadata: Record<string, unknown>
    title?: string
    output?: string
    status?: string
  }
}
export type PluginSlotSurfaceContext = PluginSurfaceContext

export type PluginWorkbenchSurface = "side" | "bottom"

export interface PluginWorkbenchTab {
  readonly id: string
  readonly panelId: string
  readonly resourceId?: string
  readonly title?: string
  readonly state?: unknown
  readonly dirty?: boolean
}

export interface PluginWorkbenchService {
  panels(
    surface: PluginWorkbenchSurface,
  ): ReadonlyArray<{ id: string; label: string; cardinality: "exclusive" | "singleton" | "multi" }>
  tabs(surface: PluginWorkbenchSurface): readonly PluginWorkbenchTab[]
  active(surface: PluginWorkbenchSurface): string | undefined
  opened(surface: PluginWorkbenchSurface): boolean
  show(surface: PluginWorkbenchSurface): void
  hide(surface: PluginWorkbenchSurface): void
  open(
    panelId: string,
    resource?: { id: string; title?: string; state?: unknown },
  ): Promise<PluginWorkbenchTab | undefined>
  activate(tabId: string): void
  move(surface: PluginWorkbenchSurface, tabId: string, index: number): void
  update(tabId: string, patch: { title?: string; state?: unknown; dirty?: boolean }): void
  close(tabId: string): Promise<boolean>
  beforeClose(tabId: string, handler: () => boolean | Promise<boolean>): () => void
}

export interface PluginWorkbenchSurfaceContext extends PluginSurfaceContext {
  tab(): PluginWorkbenchTab
}

export interface PluginDialogHandle {
  readonly closed: Promise<void>
  close(): void
}
export interface PluginUIOverlays {
  dialog(render: (handle: PluginDialogHandle) => JSX.Element): PluginDialogHandle
  confirm(options: { title: string; message: string; confirmLabel?: string }): Promise<boolean>
  notify(message: string, options?: { kind?: "info" | "success" | "warning" | "error" }): () => void
}

export interface PluginUICommand {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: string
  when?: PluginUICondition
  enabledWhen?: PluginUICondition
  menus?: readonly { location: PluginMenuLocation; order?: number; when?: PluginUICondition }[]
  execute(): void | Promise<void>
}
export interface PluginUICommands {
  register(command: PluginUICommand): () => void
  execute(id: string): Promise<boolean>
}

export type PluginExtensionOutlet =
  | { slot: import("./ui-catalog.js").PluginGenericSlot | import("./ui-catalog.js").PluginComposerSlot }
  | { slot: import("./ui-catalog.js").PluginMessageSlot; messageId: string; role: "user" | "assistant" }
export interface PluginUIExtensions {
  render(outlet: PluginExtensionOutlet): JSX.Element
}
