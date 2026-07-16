import type { I18n } from "@lingui/core"
import type { ProgressIslandSnapshot } from "./session-progress-summary"

/** Runtime Lingui descriptors for session component strings.
 *  Translate at use time via `useLocale().i18n._(descriptor)`. */

export const S = {
  lspNoServers: { id: "session.lsp.noServers", message: "No LSP servers" },

  // conversation.tsx
  convRenderEarlier: { id: "session.conversation.renderEarlier", message: "Render earlier messages" },
  convLoadEarlier: { id: "session.conversation.loadEarlier", message: "Load earlier messages" },
  convLoadingEarlier: { id: "session.conversation.loadingEarlier", message: "Loading earlier messages..." },
  convPausedTooltip: {
    id: "session.conversation.pausedTooltip",
    message: "Delivery paused during rollback. Will resume on redo or new task.",
  },
  convPaused: { id: "session.conversation.paused", message: "Paused" },
  convMoveToQueue: { id: "session.conversation.moveToQueue", message: "Move back to queue" },
  convGuideRun: { id: "session.conversation.guideRun", message: "Guide current run" },
  convRemovePending: { id: "session.conversation.removePending", message: "Remove pending message" },
  convWithdraw: { id: "session.conversation.withdraw", message: "Withdraw" },

  // permission-dock.tsx
  permDeny: { id: "session.permission.deny", message: "Deny" },
  permAllowForSession: { id: "session.permission.allowForSession", message: "Allow for session" },
  permAlwaysAllow: { id: "session.permission.alwaysAllow", message: "Always allow" },
  permAllowOnce: { id: "session.permission.allowOnce", message: "Allow once" },
  permFrom: { id: "session.permission.from", message: "from" },

  // prompt-dock.tsx
  dockBackToParent: { id: "session.dock.backToParent", message: "Back to parent" },
  dockForkedFrom: { id: "session.dock.forkedFrom", message: "Forked from" },
  dockForkSource: { id: "session.dock.forkSource", message: "Fork source" },
  dockBack: { id: "session.dock.back", message: "Back" },

  // commands.tsx — command registrations are product UI
  cmdNewSession: { id: "session.cmd.newSession", message: "New session" },
  cmdNewSessionDesc: { id: "session.cmd.newSessionDesc", message: "Start a fresh conversation" },
  cmdOpenFile: { id: "session.cmd.openFile", message: "Open file" },
  cmdOpenFileDesc: { id: "session.cmd.openFileDesc", message: "Search and open a file" },
  cmdRefreshFile: { id: "session.cmd.refreshFile", message: "Refresh current file" },
  cmdRefreshFileDesc: { id: "session.cmd.refreshFileDesc", message: "Reload the active file and expanded folders" },
  cmdToggleFileTree: { id: "session.cmd.toggleFileTree", message: "Toggle file tree" },
  cmdToggleFileTreeDesc: { id: "session.cmd.toggleFileTreeDesc", message: "Show or hide the file explorer" },
  cmdCollapseFolders: { id: "session.cmd.collapseFolders", message: "Collapse folders" },
  cmdCollapseFoldersDesc: {
    id: "session.cmd.collapseFoldersDesc",
    message: "Collapse all folders in the file explorer",
  },
  cmdToggleTerminal: { id: "session.cmd.toggleTerminal", message: "Toggle terminal" },
  cmdToggleTerminalDesc: { id: "session.cmd.toggleTerminalDesc", message: "Show or hide the terminal" },
  cmdCloseSideWs: { id: "session.cmd.closeSideWs", message: "Close side workspace" },
  cmdCloseSideWsDesc: { id: "session.cmd.closeSideWsDesc", message: "Close the side workspace" },
  cmdNewTerminal: { id: "session.cmd.newTerminal", message: "New terminal" },
  cmdNewTerminalDesc: { id: "session.cmd.newTerminalDesc", message: "Create a new terminal tab" },
  cmdPrevMessage: { id: "session.cmd.prevMessage", message: "Previous message" },
  cmdPrevMessageDesc: { id: "session.cmd.prevMessageDesc", message: "Go to the previous user message" },
  cmdNextMessage: { id: "session.cmd.nextMessage", message: "Next message" },
  cmdNextMessageDesc: { id: "session.cmd.nextMessageDesc", message: "Go to the next user message" },
  cmdChooseModel: { id: "session.cmd.chooseModel", message: "Choose model" },
  cmdChooseModelDesc: { id: "session.cmd.chooseModelDesc", message: "Select a different model" },
  cmdToggleMcp: { id: "session.cmd.toggleMcp", message: "Toggle MCPs" },
  cmdToggleMcpDesc: { id: "session.cmd.toggleMcpDesc", message: "Toggle MCPs" },
  cmdCycleAgent: { id: "session.cmd.cycleAgent", message: "Cycle agent" },
  cmdCycleAgentDesc: { id: "session.cmd.cycleAgentDesc", message: "Switch to the next agent" },
  cmdCycleAgentRev: { id: "session.cmd.cycleAgentRev", message: "Cycle agent backwards" },
  cmdCycleAgentRevDesc: { id: "session.cmd.cycleAgentRevDesc", message: "Switch to the previous agent" },
  cmdCycleEffort: { id: "session.cmd.cycleEffort", message: "Cycle thinking effort" },
  cmdCycleEffortDesc: { id: "session.cmd.cycleEffortDesc", message: "Switch to the next effort level" },
  cmdUndo: { id: "session.cmd.undo", message: "Undo" },
  cmdUndoDesc: { id: "session.cmd.undoDesc", message: "Undo the last message turn" },
  cmdRedo: { id: "session.cmd.redo", message: "Redo" },
  cmdRedoDesc: { id: "session.cmd.redoDesc", message: "Restore the last undone message turn" },
  cmdRewindToHere: { id: "session.cmd.rewindToHere", message: "Rewind to here" },
  cmdRewindToHereDesc: { id: "session.cmd.rewindToHereDesc", message: "Rewind session to the active message" },
  cmdRestoreFiles: { id: "session.cmd.restoreFiles", message: "Restore files" },
  cmdRestoreFilesDesc: { id: "session.cmd.restoreFilesDesc", message: "Restore files changed by the undone turn" },
  cmdCompact: { id: "session.cmd.compact", message: "Compact session" },
  cmdCompactDesc: { id: "session.cmd.compactDesc", message: "Summarize the session to reduce context size" },
  cmdFork: { id: "session.cmd.fork", message: "Fork session" },
  cmdForkDesc: { id: "session.cmd.forkDesc", message: "Fork the current message history" },

  // commands.tsx — toasts
  cmdToastEffortChanged: { id: "session.cmd.toast.effortChanged", message: "Thinking effort changed" },
  cmdToastEffortChangedDesc: {
    id: "session.cmd.toast.effortChangedDesc",
    message: "The thinking effort has been changed to {effort}",
  },
  cmdToastFilesRestored: { id: "session.cmd.toast.filesRestored", message: "Files restored" },
  cmdToastNoModel: { id: "session.cmd.toast.noModel", message: "No model selected" },
  cmdToastNoModelDesc: { id: "session.cmd.toast.noModelDesc", message: "Connect a provider to summarize this session" },

  // dialog-rewind-confirm.tsx — remaining hardcoded
  rewindStartingHere: { id: "session.rewind.startingHere", message: "starting here." },
  rewindAssociatedWork: { id: "session.rewind.associatedWork", message: "associated with the hidden work." },

  // rollback-banner.tsx
  rollbackCannotRedo: { id: "session.rollback.cannotRedo", message: "Cannot redo" },
  rollbackCannotRedoDesc: {
    id: "session.rollback.cannotRedo.desc",
    message: "A new task has been started. The rollback can no longer be redone.",
  },
  rollbackRedoComplete: { id: "session.rollback.redoComplete", message: "Redo complete" },
  rollbackRedoFailed: { id: "session.rollback.redoFailed", message: "Redo failed" },
  rollbackCannotRedoNew: {
    id: "session.rollback.cannotRedoNew",
    message: "New messages have been added. This rollback can no longer be redone.",
  },
  rollbackFilesRestored: { id: "session.rollback.filesRestored", message: "Files restored" },
  rollbackFilesRestoreFailed: { id: "session.rollback.filesRestoreFailed", message: "Failed to restore files" },
  rollbackRedo: { id: "session.rollback.redo", message: "Redo" },
  rollbackRestoreFiles: { id: "session.rollback.restoreFiles", message: "Restore files ({count})" },
  rollbackDismiss: { id: "session.rollback.dismiss", message: "Dismiss" },
  rollbackRestoreTooltip: { id: "session.rollback.restoreTooltip", message: "Restore the rewound messages" },
  rollbackCannotRedoTooltip: {
    id: "session.rollback.cannotRedoTooltip",
    message: "New messages have been added; cannot redo this rollback",
  },
  rollbackBannerText: {
    id: "session.rollback.bannerText",
    message:
      "Rewound {messages, plural, one {# message} other {# messages}} ({turns, plural, one {# turn} other {# turns}})",
  },

  // dialog-rewind-confirm.tsx
  rewindTitle: { id: "session.rewind.title", message: "Rewind to this point" },
  rewindBefore: {
    id: "session.rewind.description.before",
    message: 'Return to before "{title}". Hidden work can be redone until you start a new task.',
  },
  rewindBeforeUntitled: {
    id: "session.rewind.description.untitled",
    message: "Return to before this message. Hidden work can be redone until you start a new task.",
  },
  rewindConfirm: { id: "session.rewind.confirm", message: "Rewind" },
  rewindConfirmRestore: { id: "session.rewind.confirmRestore", message: "Rewind and restore files" },
  rewindFailed: { id: "session.rewind.failed", message: "Rewind failed" },
  rewindRewinding: { id: "session.rewind.rewinding", message: "Rewinding…" },
  rewindCancel: { id: "session.rewind.cancel", message: "Cancel" },
  rewindThisHides: { id: "session.rewind.thisHides", message: "This will hide" },
  rewindOptional: { id: "session.rewind.optional", message: "Optional" },
  rewindAlsoRestore: { id: "session.rewind.alsoRestore", message: "Also restore file changes" },
  rewindAlsoRestoreHint: {
    id: "session.rewind.alsoRestore.hint",
    message:
      "Revert on-disk edits made after this point across {files}. If you leave this off, you can still restore files later from the banner.",
  },

  // session-progress summary labels
  progressDone: { id: "session.progress.done", message: "Done · {count, plural, one {# task} other {# tasks}}" },
  progressNeedsAttention: {
    id: "session.progress.needsAttention",
    message: "Needs attention · {count, plural, one {# failed} other {# failed}}",
  },
  progressNeedsAttentionBlocked: {
    id: "session.progress.needsAttentionBlocked",
    message: "Needs attention · {count, plural, one {# blocked} other {# blocked}}",
  },
  progressReady: { id: "session.progress.ready", message: "Ready · {fraction}" },
  progressWorkingLabel: {
    id: "session.progress.workingLabel",
    message: "Working {count, plural, one {# task} other {# tasks}}",
  },
  progressWorking: { id: "session.progress.working", message: "Working" },

  // session-progress-island
  progressSessionLabel: { id: "session.progress.sessionLabel", message: "Session progress" },
  progressCompleteAria: {
    id: "session.progress.completeAria",
    message: "Session progress complete, {count, plural, one {# task} other {# tasks}} done",
  },
  progressAttentionAria: {
    id: "session.progress.attentionAria",
    message: "Session progress needs attention, {count} failed",
  },
  progressBlockedAria: {
    id: "session.progress.blockedAria",
    message: "Session progress needs attention, {count} blocked",
  },
  progressActiveAria: {
    id: "session.progress.activeAria",
    message: "Session progress, {completed} of {total} tasks complete",
  },
  progressDagTab: { id: "session.progress.dagTab", message: "DAG" },
  progressTodoTab: { id: "session.progress.todoTab", message: "To-do" },
  progressCurrentWork: { id: "session.progress.currentWork", message: "Current work" },
  progressCompleteFraction: { id: "session.progress.completeFraction", message: "{completed}/{total} complete" },
  progressActiveCount: { id: "session.progress.activeCount", message: "{count} active" },
  progressWaitingCount: { id: "session.progress.waitingCount", message: "{count} waiting" },
  progressViewLabel: { id: "session.progress.viewLabel", message: "Progress view" },
  progressExpand: { id: "session.progress.expand", message: "Expand" },
  progressCollapse: { id: "session.progress.collapse", message: "Collapse" },
  progressNoActivePlan: { id: "session.progress.noActivePlan", message: "No active plan" },
  progressNoActiveTasks: { id: "session.progress.noActiveTasks", message: "No active tasks" },
  progressTodoActive: { id: "session.progress.todoActive", message: "active" },
  progressTodoDone: { id: "session.progress.todoDone", message: "done" },
  progressTodoSkipped: { id: "session.progress.todoSkipped", message: "skipped" },
  progressCompleted: { id: "session.progress.completed", message: "{count} completed" },
  progressActiveCountLabel: { id: "session.progress.activeCountLabel", message: "{count} active" },
  progressPendingCount: { id: "session.progress.pendingCount", message: "{count} pending" },
  progressTodoCompleted: { id: "session.progress.todoCompleted", message: "{count} completed" },

  // session-context-panel
  contextPanelTitle: { id: "session.context.panelTitle", message: "Context" },
  contextPanelClose: { id: "session.context.closeAriaLabel", message: "Close Context" },

  // session-context-usage
  contextTokens: { id: "session.context.tokens", message: "Tokens" },
  contextUsage: { id: "session.context.usage", message: "Usage" },
  contextCost: { id: "session.context.cost", message: "Cost" },
  contextClickToView: { id: "session.context.clickToView", message: "Click to view context" },

  // session-context-tab
  contextTabSystem: { id: "session.context.tab.system", message: "System" },
  contextTabUser: { id: "session.context.tab.user", message: "User" },
  contextTabAssistant: { id: "session.context.tab.assistant", message: "Assistant" },
  contextTabToolCalls: { id: "session.context.tab.toolCalls", message: "Tool Calls" },
  contextTabOther: { id: "session.context.tab.other", message: "Other" },
  contextTabSession: { id: "session.context.tab.session", message: "Session" },
  contextTabMessages: { id: "session.context.tab.messages", message: "Messages" },
  contextTabProvider: { id: "session.context.tab.provider", message: "Provider" },
  contextTabModel: { id: "session.context.tab.model", message: "Model" },
  contextTabContextLimit: { id: "session.context.tab.contextLimit", message: "Context Limit" },
  contextTabTotalTokens: { id: "session.context.tab.totalTokens", message: "Total Tokens" },
  contextTabUsage: { id: "session.context.tab.usage", message: "Usage" },
  contextTabInputTokens: { id: "session.context.tab.inputTokens", message: "Input Tokens" },
  contextTabOutputTokens: { id: "session.context.tab.outputTokens", message: "Output Tokens" },
  contextTabReasoningTokens: { id: "session.context.tab.reasoningTokens", message: "Reasoning Tokens" },
  contextTabCacheTokens: { id: "session.context.tab.cacheTokens", message: "Cache Tokens (read/write)" },
  contextTabUserMessages: { id: "session.context.tab.userMessages", message: "User Messages" },
  contextTabAssistantMessages: { id: "session.context.tab.assistantMessages", message: "Assistant Messages" },
  contextTabTotalCost: { id: "session.context.tab.totalCost", message: "Total Cost" },
  contextTabSessionCreated: { id: "session.context.tab.sessionCreated", message: "Session Created" },
  contextTabLastActivity: { id: "session.context.tab.lastActivity", message: "Last Activity" },
  contextTabBreakdown: { id: "session.context.tab.breakdown", message: "Context Breakdown" },
  contextTabSysPrompt: { id: "session.context.tab.sysPrompt", message: "System Prompt" },
  contextTabRawMessages: { id: "session.context.tab.rawMessages", message: "Raw messages" },
  contextTabBreakdownHint: {
    id: "session.context.tab.breakdown.hint",
    message: 'Approximate breakdown of input tokens. "Other" includes tool definitions and overhead.',
  },

  // session-inbox
  inboxQueued: { id: "session.inbox.queued", message: "Queued by you" },
  inboxGuiding: { id: "session.inbox.guiding", message: "Guiding current run" },
  inboxContextUpdate: { id: "session.inbox.contextUpdate", message: "Context update" },
  inboxUpdate: { id: "session.inbox.update", message: "Update" },
  inboxAfterTurn: { id: "session.inbox.afterTurn", message: "After turn" },
  inboxNextCall: { id: "session.inbox.nextCall", message: "Next call" },
  inboxContextTag: { id: "session.inbox.contextTag", message: "Context" },
  inboxContext: { id: "session.inbox.contextWord", message: "Context" },
  inboxDeliveryTask: {
    id: "session.inbox.delivery.task",
    message: "Sends after this turn; multiple queued items share one reply cycle.",
  },
  inboxDeliverySteer: {
    id: "session.inbox.delivery.steer",
    message: "Joins the current run before its next model request.",
  },
  inboxDeliveryContext: {
    id: "session.inbox.delivery.context",
    message: "Joined to the ongoing model call as context.",
  },
  inboxQueueNextCall: { id: "session.inbox.queue.nextCall", message: "{steers} next call · {tasks} after turn" },
  inboxQueueJoinModel: {
    id: "session.inbox.queue.joinModel",
    message: "{count, plural, one {# item joins} other {# items join}} the next model call",
  },
  inboxQueueJoinSingular: {
    id: "session.inbox.queue.joinSingular",
    message: "Joins the current run's next model call",
  },
  inboxQueueTasks: {
    id: "session.inbox.queue.tasks",
    message: "{count, plural, one {# item sends} other {# items send}} together in one reply",
  },
  inboxQueueTasksSingular: { id: "session.inbox.queue.tasksSingular", message: "Sends automatically after this turn" },
  inboxQueueContexts: { id: "session.inbox.queue.contexts", message: "{count} context updates waiting" },
  inboxQueueContextSingular: { id: "session.inbox.queue.contextSingular", message: "Context update waiting" },
  inboxClear: { id: "session.inbox.clear", message: "Inbox clear" },
  inboxDetailAria: { id: "session.inbox.detailAria", message: "Queued message actions" },
  inboxDebug: { id: "session.inbox.debug", message: "Checking for queued messages" },
  inboxTitle: { id: "session.inbox.title", message: "Inbox" },
  inboxEmpty: { id: "session.inbox.empty", message: "Inbox clear" },
  inboxLoading: { id: "session.inbox.loading", message: "Loading inbox…" },
  inboxFrozen: { id: "session.inbox.frozen", message: "Inbox frozen while rewinding" },
  inboxSendAll: { id: "session.inbox.sendAll", message: "Send all now" },
  inboxGuideQueue: { id: "session.inbox.guide.queue", message: "Queue" },
  inboxGuideSendNow: { id: "session.inbox.guide.sendNow", message: "Send now" },
  inboxGuideQueueTip: {
    id: "session.inbox.guide.queueTip",
    message: "Move this message back to the queued task list.",
  },
  inboxGuideSendNowTip: {
    id: "session.inbox.guide.sendNowTip",
    message: "Add this message to the current run's next model call.",
  },
  inboxGuideFailed: { id: "session.inbox.guideFailed", message: "Failed to send message now" },
  inboxGuideAllFailed: { id: "session.inbox.guideAllFailed", message: "Failed to send queued messages now" },
  inboxDelete: { id: "session.inbox.delete", message: "Delete" },
  inboxRemoved: { id: "session.inbox.removed", message: "Removed queued message" },
  inboxRemovedDesc: {
    id: "session.inbox.removedDesc",
    message: "The message has been removed from the inbox. Restoring it will add it to the queue tail.",
  },
  inboxRestore: { id: "session.inbox.restore", message: "Restore" },
  inboxItemsWaiting: {
    id: "session.inbox.itemsWaiting",
    message: "{count} {count, plural, one {item} other {items}} waiting for your attention",
  },
  inboxSessionAria: { id: "session.inbox.sessionAria", message: "Session inbox" },

  // question-prompt
  questionNeedsInput: { id: "session.question.needsInput", message: "Needs your input" },
  questionOpen: { id: "session.question.open", message: "Open" },
  questionCollapseTitle: { id: "session.question.collapse", message: "Collapse" },
  questionSkip: { id: "session.question.skip", message: "Skip" },
  questionSkipTitle: { id: "session.question.skipTitle", message: "Skip question" },
  questionReview: { id: "session.question.review", message: "Review" },
  questionOtherAnswer: { id: "session.question.otherAnswer", message: "Other answer" },
  questionOtherDesc: { id: "session.question.otherDesc", message: "Type a different answer" },
  questionReviewTitle: { id: "session.question.reviewTitle", message: "Review your answers" },
  questionNotAnswered: { id: "session.question.notAnswered", message: "Not answered" },
  questionEdit: { id: "session.question.edit", message: "Edit" },
  questionPrevious: { id: "session.question.previous", message: "Previous" },
  questionNext: { id: "session.question.next", message: "Next" },
  questionSubmit: { id: "session.question.submit", message: "Submit" },
  questionAdd: { id: "session.question.add", message: "Add" },
  questionStepsAria: { id: "session.question.stepsAria", message: "Question steps" },
  questionAria: { id: "session.question.aria", message: "Question awaiting your input" },
  questionCustomPlaceholder: { id: "session.question.customPlaceholder", message: "Type your own answer..." },
  questionMultiHint: { id: "session.question.multiHint", message: " *(select all that apply)*" },
  questionStepLabel: { id: "session.question.stepLabel", message: "Question {index}" },

  // session-new-view
  newSessionSubtitle: { id: "session.new.subtitle", message: "What are we building today?" },

  // scopes
  scopesActive: { id: "scopes.active", message: "Active" },
  scopesSession: { id: "scopes.session", message: "session" },
  scopesSubsession: { id: "scopes.subsession", message: "subsession" },
  scopesRename: { id: "scopes.rename", message: "Rename" },
  scopesArchive: { id: "scopes.archive", message: "Archive" },
  scopesWorking: { id: "scopes.working", message: "Working…" },
  scopesRetrying: { id: "scopes.retrying", message: "Retrying…" },
  scopesPermissionRequest: { id: "scopes.permissionRequest", message: "Permission request" },
  scopesError: { id: "scopes.error", message: "Error" },
  scopesNewActivity: { id: "scopes.newActivity", message: "New activity" },
  scopesNewSession: { id: "scopes.newSession", message: "New session" },
  scopesTasksRunning: { id: "scopes.tasksRunning", message: "{running}/{count} tasks running" },
  scopesTasksCount: { id: "scopes.tasksCount", message: "{count} tasks" },
}

/** Stateless formatting helpers that accept i18n + snapshot. */
export function describeProgress(snapshot: ProgressIslandSnapshot, i18n: I18n): string {
  if (snapshot.status === "hidden") return i18n._(S.progressSessionLabel)
  if (snapshot.status === "complete") return i18n._({ ...S.progressCompleteAria, values: { count: snapshot.total } })
  if (snapshot.tone === "failed") return i18n._({ ...S.progressAttentionAria, values: { count: snapshot.failed } })
  if (snapshot.tone === "blocked") return i18n._({ ...S.progressBlockedAria, values: { count: snapshot.blocked } })
  return i18n._({ ...S.progressActiveAria, values: { completed: snapshot.completed, total: snapshot.total } })
}

export function progressExpandCollapse(expanded: boolean, i18n: I18n): string {
  return expanded ? i18n._(S.progressCollapse) : i18n._(S.progressExpand)
}

export function formatProgressLabel(
  snapshot: ProgressIslandSnapshot,
  activeLabel: string | undefined,
  i18n: I18n,
): string {
  if (snapshot.status === "hidden") return ""
  if (snapshot.status === "complete") return i18n._({ ...S.progressDone, values: { count: snapshot.total } })
  if (snapshot.tone === "failed") return i18n._({ ...S.progressNeedsAttention, values: { count: snapshot.failed } })
  if (snapshot.tone === "blocked")
    return i18n._({ ...S.progressNeedsAttentionBlocked, values: { count: snapshot.blocked } })
  const fraction = `${snapshot.completed}/${snapshot.total}`
  const label = activeLabel?.trim()
  if (label) return `${label} · ${fraction}`
  if (snapshot.tone === "ready") return i18n._({ ...S.progressReady, values: { fraction } })
  if (snapshot.active > 1)
    return `${i18n._({ ...S.progressWorkingLabel, values: { count: snapshot.active } })} · ${fraction}`
  return `${i18n._(S.progressWorking)} · ${fraction}`
}
