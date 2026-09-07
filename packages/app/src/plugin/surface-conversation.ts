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
  let releaseContent: (() => void) | undefined
  return {
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
      contentRef(element) {
        if (!element) {
          releaseContent?.()
          releaseContent = undefined
          return
        }
        read()
        releaseContent?.()
        releaseContent = element
          ? access.own("session.read", () => {
              source.autoScroll.contentRef(element)
              return () => source.autoScroll.contentRef(undefined)
            })
          : undefined
      },
      handleScroll: () => read().autoScroll.handleScroll(),
      handleInteraction: (event) => read().autoScroll.handleInteraction(event),
      forceScrollToBottom: () => read().autoScroll.forceScrollToBottom(),
    },
    onClearHash: () => read().onClearHash(),
    onScheduleScrollSpy: (container) => read().onScheduleScrollSpy(container),
    setScrollRef(element) {
      if (!element) {
        releaseScroll?.()
        releaseScroll = undefined
        return
      }
      read()
      releaseScroll?.()
      releaseScroll = element
        ? access.own("session.read", () => {
            source.setScrollRef(element)
            return () => source.setScrollRef(undefined)
          })
        : undefined
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
