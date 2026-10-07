import type { Accessor, JSX } from "solid-js"
import type {
  Message,
  UserMessage,
  AssistantMessage,
  SessionInboxItem,
  SessionPartSummary,
} from "@ericsanchezok/synergy-sdk"

export interface PluginConversationContent {
  summaries(messageID: string): readonly SessionPartSummary[]
  page(messageID: string): { hasMore: boolean; hasEarlier?: boolean; stale?: boolean } | undefined
  load(messageID: string, more?: boolean, force?: boolean): Promise<void>
  retain(part: SessionPartSummary): { ready: Promise<void>; release(): void }
  text?(messageID: string): Promise<string>
  loadWindow?(messageID: string, partID?: string): Promise<boolean>
  loadEarlier?(messageID: string): Promise<void>
}

export interface PluginTurnProjection {
  readonly roots: readonly UserMessage[]
  readonly byRoot: ReadonlyMap<string, readonly (UserMessage | AssistantMessage)[]>
  readonly memberIndex: ReadonlyMap<string, number>
  readonly compactionParentIDs: ReadonlySet<string>
  turnMessagesFor(anchor: UserMessage | undefined): readonly (UserMessage | AssistantMessage)[]
}

export interface PluginConversationViewport {
  contentRef(element: HTMLElement | undefined, releaseOf?: HTMLElement): void
  handleScroll(): void
  handleInteraction(event: Event): void
  forceScrollToBottom(): void
}

export interface PluginConversationActivityView {
  getExpanded(key: string): boolean | undefined
  setExpanded(key: string, expanded: boolean): void
}

export interface PluginConversationService {
  content?: PluginConversationContent
  registerMessageLocator?: (
    locate: (messageID: string, behavior?: ScrollBehavior, partID?: string) => Promise<boolean>,
  ) => () => void
  sessionID: string
  timeline: Accessor<readonly Message[]>
  turnProjection: Accessor<PluginTurnProjection>
  activityDisplay: Accessor<"full" | "balanced" | "minimal">
  activityView?: PluginConversationActivityView
  pendingTimeline?: Accessor<readonly SessionInboxItem[]>
  transition?: () => JSX.Element
  onFirstTurnMounted(): void
  canRewind(message: UserMessage): boolean
  visibleUserMessages: Accessor<readonly UserMessage[]>
  hasCanonicalRoot: Accessor<boolean>
  lastUserMessage: Accessor<UserMessage | undefined>
  activeMessage: Accessor<UserMessage | undefined>
  workspaceOpen?: Accessor<boolean>
  isWorking: Accessor<boolean>
  compactReasoning: Accessor<boolean>
  turnStart: number
  turnBatch: number
  onSetTurnStart: (start: number) => void
  historyMore: Accessor<boolean>
  historyLoading: Accessor<boolean>
  historyMode: Accessor<"latest" | "history">
  historyPendingLatest: Accessor<boolean>
  onReturnLatest: () => void
  onLoadMore: () => void
  scrolledUp: Accessor<boolean>
  onScrolledUpChange: (val: boolean) => void
  autoScroll: PluginConversationViewport
  onClearHash: () => void
  onScheduleScrollSpy: (container: HTMLDivElement) => void
  setScrollRef: (el: HTMLDivElement | undefined, releaseOf?: HTMLDivElement) => void
  isDesktop: Accessor<boolean>
  scrollToMessage: (msg: UserMessage, behavior?: ScrollBehavior) => void
  anchor: (id: string) => string
  terminalHeight: Accessor<number>
  onRewind?: (message: UserMessage) => void
  onReviewChanges?: (input: { messageID: string; file?: string }) => void
  onForkMessage?: (messageID: string) => void
  onPendingGuide?: (item: SessionInboxItem) => void
  onPendingRemove?: (item: SessionInboxItem) => void
  rollbackActive?: boolean
}
