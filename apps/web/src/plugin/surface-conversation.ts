import type { PluginConversationService } from "@ericsanchezok/synergy-plugin"
import type { createPluginSurfaceAccess } from "./surface-access"

export function bindPluginConversation(
  source: PluginConversationService,
  access: ReturnType<typeof createPluginSurfaceAccess>,
): PluginConversationService {
  const read = () => {
    access.require("session.read")
    return source
  }
  const control = () => {
    access.require("session.control")
    return source
  }
  let releaseScroll: (() => void) | undefined
  let releaseScrollElement: HTMLDivElement | undefined
  let releaseContent: (() => void) | undefined
  let releaseContentElement: HTMLElement | undefined
  return {
    get content(): PluginConversationService["content"] {
      if (!read().content) return undefined
      return {
        summaries: (messageID) => read().content!.summaries(messageID),
        page: (messageID) => read().content!.page(messageID),
        load: (messageID, more, force) =>
          access.run("session.read", () => source.content!.load(messageID, more, force)),
        text: source.content?.text
          ? (messageID) => access.run("session.read", () => source.content!.text!(messageID))
          : undefined,
        loadWindow: source.content?.loadWindow
          ? (messageID, partID) => access.run("session.read", () => source.content!.loadWindow!(messageID, partID))
          : undefined,
        loadEarlier: source.content?.loadEarlier
          ? (messageID) => access.run("session.read", () => source.content!.loadEarlier!(messageID))
          : undefined,
        retain(part) {
          read()
          const lease = source.content!.retain(part)
          const release = access.own("session.read", () => lease.release)
          return { ready: access.run("session.read", () => lease.ready), release }
        },
      }
    },
    registerMessageLocator(locate) {
      return access.own(
        "session.read",
        () =>
          source.registerMessageLocator?.((messageID, behavior, partID) =>
            access.run("session.read", () => locate(messageID, behavior, partID)),
          ) ?? (() => {}),
      )
    },
    get sessionID() {
      return read().sessionID
    },
    get turnStart() {
      return read().turnStart
    },
    get turnBatch() {
      return read().turnBatch
    },
    get rollbackActive() {
      return read().rollbackActive
    },
    timeline: () => read().timeline(),
    turnProjection: () => read().turnProjection(),
    activityDisplay: () => read().activityDisplay(),
    pendingTimeline: () => read().pendingTimeline?.() ?? [],
    transition: () => read().transition?.(),
    onFirstTurnMounted: () => read().onFirstTurnMounted(),
    canRewind: (message) => read().canRewind(message),
    visibleUserMessages: () => read().visibleUserMessages(),
    hasCanonicalRoot: () => read().hasCanonicalRoot(),
    lastUserMessage: () => read().lastUserMessage(),
    activeMessage: () => read().activeMessage(),
    workspaceOpen: () => read().workspaceOpen?.() ?? false,
    isWorking: () => read().isWorking(),
    compactReasoning: () => read().compactReasoning(),
    onSetTurnStart: (start) => read().onSetTurnStart(start),
    historyMore: () => read().historyMore(),
    historyLoading: () => read().historyLoading(),
    historyMode: () => read().historyMode(),
    historyPendingLatest: () => read().historyPendingLatest(),
    onReturnLatest: () => read().onReturnLatest(),
    onLoadMore: () => read().onLoadMore(),
    scrolledUp: () => read().scrolledUp(),
    onScrolledUpChange: (value) => read().onScrolledUpChange(value),
    autoScroll: {
      readingAnchorOwner: () => read().autoScroll.readingAnchorOwner(),
      contentRef(element, releaseOf) {
        if (!element && releaseOf !== undefined && releaseContentElement !== releaseOf) return
        if (!element) {
          releaseContent?.()
          releaseContent = undefined
          releaseContentElement = undefined
          return
        }
        read()
        releaseContent?.()
        releaseContentElement = element
        releaseContent = access.own("session.read", () => {
          source.autoScroll.contentRef(element)
          return () => {
            source.autoScroll.contentRef(undefined, element)
          }
        })
      },
      handleScroll: () => read().autoScroll.handleScroll(),
      handleInteraction: (event) => read().autoScroll.handleInteraction(event),
      forceScrollToBottom: () => read().autoScroll.forceScrollToBottom(),
    },
    onClearHash: () => read().onClearHash(),
    onScheduleScrollSpy: (container) => read().onScheduleScrollSpy(container),
    setScrollRef(element, releaseOf) {
      if (!element && releaseOf !== undefined && releaseScrollElement !== releaseOf) return
      if (!element) {
        releaseScroll?.()
        releaseScroll = undefined
        releaseScrollElement = undefined
        return
      }
      read()
      releaseScroll?.()
      releaseScrollElement = element
      releaseScroll = access.own("session.read", () => {
        source.setScrollRef(element)
        return () => {
          source.setScrollRef(undefined, element)
        }
      })
    },
    isDesktop: () => read().isDesktop(),
    scrollToMessage: (message, behavior) => read().scrollToMessage(message, behavior),
    anchor: (id) => read().anchor(id),
    terminalHeight: () => read().terminalHeight(),
    onRewind: (message) => control().onRewind?.(message),
    onForkMessage: (id) => control().onForkMessage?.(id),
    onPendingGuide: (item) => control().onPendingGuide?.(item),
    onPendingRemove: (item) => control().onPendingRemove?.(item),
    onReviewChanges(input) {
      access.require("workbench.write")
      read().onReviewChanges?.(input)
    },
  }
}
