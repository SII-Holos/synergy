/** Runtime Lingui descriptors for prompt-input component strings.
 *  Each is a plain object with `id` + English `message`.
 *  Translate at use time via `useLocale().i18n._(descriptor)` or
 *  `i18n._({ ...descriptor, values: {...} })` when ICU placeholders are present. */

export const PI = {
  // submit.ts toasts
  submitPendingTitle: { id: "prompt.submit.pending.title", message: "Workspace setup in progress" },
  submitPendingDesc: {
    id: "prompt.submit.pending.description",
    message: "Wait for the worktree setup to finish before sending another prompt.",
  },
  submitTransitionPendingTitle: {
    id: "prompt.submit.transitionPending.title",
    message: "Session transition in progress",
  },
  submitTransitionPendingDesc: {
    id: "prompt.submit.transitionPending.description",
    message: "Wait for the current session transition to finish before sending another message.",
  },
  submitQueued: { id: "prompt.submit.queued", message: "Message queued" },
  submitMessageAria: { id: "prompt.submit.messageAria", message: "Submit message" },
  submitInProgress: { id: "prompt.submit.inProgress", message: "Session start in progress" },
  submitInProgressDesc: {
    id: "prompt.submit.inProgress.description",
    message: "Wait for this session to finish starting before sending another prompt.",
  },
  submitLightLoopTitle: { id: "prompt.submit.lightLoop.title", message: "Describe the Light Loop task" },
  submitLightLoopDesc: {
    id: "prompt.submit.lightLoop.description",
    message: "Write the task first; attachments and references can only add context.",
  },
  submitAddMessage: { id: "prompt.submit.addMessage", message: "Add a message" },
  submitAddMessageDesc: {
    id: "prompt.submit.addMessage.description",
    message: "Attachments and references need a text prompt.",
  },
  submitNormalMessage: { id: "prompt.submit.useNormal", message: "Use a normal message" },
  submitNormalMessageDesc: {
    id: "prompt.submit.useNormal.description",
    message: "Light Loop starts from the next text prompt, not shell mode.",
  },
  submitSelectAgent: { id: "prompt.submit.selectAgent", message: "Select an agent and model" },
  submitSelectAgentDesc: {
    id: "prompt.submit.selectAgent.description",
    message: "Choose an agent and model before sending a prompt.",
  },
  submitFailedStart: { id: "prompt.submit.failedStart", message: "Failed to start session" },
  submitSessionNotStarted: { id: "prompt.submit.sessionNotStarted", message: "Session was not started." },
  submitFailedWorktree: { id: "prompt.submit.failedWorktree", message: "Failed to prepare worktree" },
  submitFailedBlueprint: { id: "prompt.submit.failedBlueprint", message: "Failed to start Blueprint" },
  submitFailedShell: { id: "prompt.submit.failedShell", message: "Failed to send shell command" },
  submitFailedCommand: { id: "prompt.submit.failedCommand", message: "Failed to send command" },
  submitFailedExitWorkflow: { id: "prompt.submit.failedExitWorkflow", message: "Failed to exit {workflow}" },
  submitFailedSend: { id: "prompt.submit.failedSend", message: "Failed to send prompt" },
  submitFailedLightLoop: { id: "prompt.submit.failedLightLoop", message: "Failed to enable Light Loop" },
  submitFailedTogglePlan: { id: "prompt.submit.failedTogglePlan", message: "Failed to toggle Plan" },
  submitFailedEnableLattice: { id: "prompt.submit.failedEnableLattice", message: "Failed to enable Lattice" },
  submitSent: { id: "prompt.submit.sent", message: "Message sent" },
  submitSentDesc: { id: "prompt.submit.sent.description", message: "Response will appear after reconnection" },

  // prompt-input.tsx — toasts
  sessionRunning: { id: "prompt.sessionRunning", message: "Session is running" },
  stopBeforeChange: { id: "prompt.stopBeforeChange", message: "Stop the session before changing workflow modes." },
  blueprintUnequipped: { id: "prompt.blueprint.unequipped", message: "Blueprint unequipped" },
  blueprintRunStopped: { id: "prompt.blueprint.runStopped", message: "Blueprint run stopped" },
  blueprintUnknownError: { id: "prompt.blueprint.unknownError", message: "Unknown error" },
  blueprintSlotOccupied: { id: "prompt.blueprint.slotOccupied", message: "Blueprint slot occupied" },
  blueprintUnequipFirst: {
    id: "prompt.blueprint.unequipFirst",
    message: "Unequip the current Blueprint before equipping another one.",
  },
  blueprintEquipped: { id: "prompt.blueprint.equipped", message: "Blueprint equipped" },
  blueprintEquippedDesc: { id: "prompt.blueprint.equippedDesc", message: "Send when you are ready to start it." },
  blueprintEquipFailed: { id: "prompt.blueprint.equipFailed", message: "Failed to equip Blueprint" },
  blueprintWaitResponse: {
    id: "prompt.blueprint.waitResponse",
    message: "Wait for the current response before equipping this Blueprint.",
  },
  latticeCancelFailed: { id: "prompt.lattice.cancelFailed", message: "Failed to cancel Lattice" },
  lightLoopToggleFailed: { id: "prompt.lightLoop.toggleFailed", message: "Failed to toggle Light Loop" },
  lightLoopWaitStop: {
    id: "prompt.lightLoop.waitStop",
    message: "Wait for Light Loop to stop before equipping a Blueprint.",
  },
  planWaitFinish: { id: "prompt.plan.waitFinish", message: "Wait for Plan to finish before equipping a Blueprint." },
  sessionWaitFinish: {
    id: "prompt.session.waitFinish",
    message: "Wait for the current session run to finish before equipping a Blueprint.",
  },
  latticeActive: { id: "prompt.lattice.active", message: "Lattice is active" },
  latticeCancelBeforeBp: {
    id: "prompt.lattice.cancelBeforeBp",
    message: "Cancel Lattice before equipping a user Blueprint.",
  },
  permModeUnchanged: { id: "prompt.permMode.unchanged", message: "Permission mode unchanged" },
  permModeUpdateFailed: {
    id: "prompt.permMode.updateFailed",
    message: "Failed to update the session permission mode.",
  },
  commandSendFailed: { id: "prompt.command.sendFailed", message: "Failed to send command" },

  // prompt-input.tsx — workflow chips / tooltips
  exitPlan: { id: "prompt.exitPlan", message: "Exit Plan" },
  exitPlanLabel: { id: "prompt.exitPlan.label", message: "Plan" },
  cancelLightLoopLabel: { id: "prompt.cancelLightLoop.label", message: "Light Loop" },
  cancelLightLoop: { id: "prompt.cancelLightLoop", message: "Cancel Light Loop" },
  cancelLatticeLabel: { id: "prompt.cancelLattice.label", message: "Lattice" },
  cancelLattice: { id: "prompt.cancelLattice", message: "Cancel Lattice" },
  connectionLost: { id: "prompt.connectionLost", message: "Connection lost — responses may be delayed" },
  loopReady: { id: "prompt.loopReady", message: "Loop ready" },
  startBpLoop: { id: "prompt.startBlueprintLoop", message: "Start BlueprintLoop" },
  stopAction: { id: "prompt.stop", message: "Stop" },
  sendAction: { id: "prompt.send", message: "Send" },
  workspacePending: { id: "prompt.workspacePending", message: "Workspace setup in progress" },
  startingSession: { id: "prompt.startingSession", message: "Starting session" },
  stopSession: { id: "prompt.stopSession", message: "Stop session" },
  sendMessage: { id: "prompt.sendMessage", message: "Send message" },
  selectAgent: { id: "prompt.selectAgent", message: "Select agent" },
  externalAgentBlocked: {
    id: "prompt.externalAgentBlocked",
    message: "Create a new session to use this external agent",
  },

  // prompt-input.tsx — toolbar / chips
  toolbarAgent: { id: "prompt.toolbar.agent", message: "Agent" },
  toolbarContext: { id: "prompt.toolbar.context", message: "Context" },
  toolbarAddFiles: { id: "prompt.toolbar.addFiles", message: "Add files" },
  toolbarAttachFiles: { id: "prompt.toolbar.attachFiles", message: "Attach files or images" },
  toolbarWorkflow: { id: "prompt.toolbar.workflow", message: "Workflow" },
  toolbarWorkspace: { id: "prompt.toolbar.workspace", message: "Workspace" },
  toolbarWorktree: { id: "prompt.toolbar.worktree", message: "Worktree" },
  toolbarWorktreeDesc: { id: "prompt.toolbar.worktreeDesc", message: "Isolated checkout" },

  // prompt-input.tsx — blueprint slot status labels
  bpSlotReady: { id: "prompt.bpSlot.ready", message: "Ready to start" },
  bpSlotEquipped: { id: "prompt.bpSlot.equipped", message: "Equipped" },
  bpSlotRunning: { id: "prompt.bpSlot.running", message: "Running" },
  bpSlotWaiting: { id: "prompt.bpSlot.waiting", message: "Waiting" },
  bpSlotAuditing: { id: "prompt.bpSlot.auditing", message: "In review" },
  bpSlotCompleted: { id: "prompt.bpSlot.completed", message: "Completed" },
  bpSlotFailed: { id: "prompt.bpSlot.failed", message: "Needs attention" },
  bpSlotCancelled: { id: "prompt.bpSlot.cancelled", message: "Unequipped" },

  // prompt-input.tsx — blueprint slot hold labels
  bpHoldStopRun: { id: "prompt.bpHold.stopRun", message: "Hold for 2 seconds to stop this Blueprint run." },
  bpHoldCancelLoop: { id: "prompt.bpHold.cancelLoop", message: "Hold for 2 seconds to cancel this BlueprintLoop." },
  bpHoldUnequip: { id: "prompt.bpHold.unequip", message: "Hold for 2 seconds to unequip." },

  // prompt-input.tsx — blueprint slot aria labels
  bpAriaHoldStop: { id: "prompt.bpAria.holdStop", message: "Hold to stop Blueprint run: {title}" },
  bpAriaHoldCancel: { id: "prompt.bpAria.holdCancel", message: "Hold to cancel BlueprintLoop: {title}" },
  bpAriaHoldUnequip: { id: "prompt.bpAria.holdUnequip", message: "Hold to unequip Blueprint: {title}" },

  // prompt-input.tsx — blueprint failure titles
  bpFailUnequip: { id: "prompt.bpFail.unequip", message: "Failed to unequip Blueprint" },
  bpFailStoppedEquipped: { id: "prompt.bpFail.stoppedEquipped", message: "Session stopped, Blueprint still equipped" },
  bpFailStopRun: { id: "prompt.bpFail.stopRun", message: "Failed to stop Blueprint run" },

  // prompt-input.tsx — generic error / request failed
  genericRequestFailed: { id: "prompt.generic.requestFailed", message: "Request failed" },

  // prompt-input.tsx — editor placeholders
  placeholderShell: { id: "prompt.placeholder.shell", message: "Enter shell command..." },
  placeholderPlan: { id: "prompt.placeholder.plan", message: "Plan your approach..." },
  placeholderAskGlobal: { id: "prompt.placeholder.askGlobal", message: "Ask me anything..." },
  placeholderAskProject: { id: "prompt.placeholder.askProject", message: "Ask anything..." },

  // prompt-input.tsx — light-loop active description
  lightLoopNextMsg: { id: "prompt.lightLoop.nextMessage", message: "Next message starts the loop" },

  // prompt-input.tsx — new session start options
  wsLabelWorkspace: { id: "prompt.ws.workspace", message: "Workspace" },
  wsLabelHome: { id: "prompt.ws.home", message: "Home" },
  wsLabelMainCheckout: { id: "prompt.ws.mainCheckout", message: "Main checkout" },
  wsDescGlobal: { id: "prompt.ws.globalDesc", message: "Global context" },
  wsDescCurrent: { id: "prompt.ws.currentDesc", message: "Current checkout" },
  wsWorktreeTooltipCan: {
    id: "prompt.ws.worktreeTooltipCan",
    message: "Create an isolated worktree for this session.",
  },
  wsWorktreeTooltipCannot: {
    id: "prompt.ws.worktreeTooltipCannot",
    message: "Choose a project to use worktree isolation.",
  },

  // workflow descriptions
  workflowLightLoop: { id: "prompt.workflow.lightLoop", message: "Light Loop" },
  workflowLightLoopDesc: { id: "prompt.workflow.lightLoopDesc", message: "Auto-continue until task is done" },
  workflowPlan: { id: "prompt.workflow.plan", message: "Plan" },
  workflowPlanDesc: { id: "prompt.workflow.planDesc", message: "Planning before execution" },
  workflowPlanDescAlt: { id: "prompt.workflow.planDescAlt", message: "Ask for an approach first" },
  workflowLattice: { id: "prompt.workflow.lattice", message: "Lattice" },
  workflowUnavailableBlueprint: {
    id: "prompt.workflow.unavailable.blueprint",
    message: "Light Loop is unavailable while a Blueprint is equipped",
  },
  workflowUnavailableAlready: { id: "prompt.workflow.unavailable.already", message: "Light Loop is already enabled" },
  workflowUnavailablePlan: {
    id: "prompt.workflow.unavailable.plan",
    message: "Light Loop is unavailable while Plan is active",
  },
  workflowUnavailableLattice: {
    id: "prompt.workflow.unavailable.lattice",
    message: "Light Loop is unavailable while Lattice is active",
  },
  workflowPlanUnavailableBp: {
    id: "prompt.workflow.planUnavailable.bp",
    message: "Plan is unavailable while a Blueprint is equipped",
  },
  workflowPlanUnavailableAlready: { id: "prompt.workflow.planUnavailable.already", message: "Plan is already enabled" },
  workflowPlanUnavailableLl: {
    id: "prompt.workflow.planUnavailable.ll",
    message: "Plan is unavailable while Light Loop is active",
  },
  workflowPlanUnavailableLattice: {
    id: "prompt.workflow.planUnavailable.lattice",
    message: "Plan is unavailable while Lattice is active",
  },

  // prompt-input.tsx — shell / drop zone / blueprint
  shellLabel: { id: "prompt.shell.label", message: "Shell" },
  shellEscToExit: { id: "prompt.shell.escToExit", message: "esc to exit" },
  dropZone: { id: "prompt.dropZone", message: "Drop supported files, notes, or sessions here" },
  bpReady: { id: "prompt.bp.ready", message: "Ready to start this BlueprintLoop." },
  bpLabel: { id: "prompt.bp.label", message: "Blueprint" },
  bpStatusLabel: { id: "prompt.bp.statusLabel", message: "Blueprint {status}" },
  escKey: { id: "prompt.escKey", message: "ESC" },

  // permission-selector.tsx
  permissionMode: { id: "session.permission.title", message: "Permission mode" },
  permissionModeAria: { id: "session.permission.ariaLabel", message: "{mode} permission mode" },
  permissionRunning: { id: "session.permission.sessionRunning", message: "Session is running" },
  permissionStopBefore: {
    id: "session.permission.stopBeforeChange",
    message: "Stop the session before changing its permission mode.",
  },
  permissionStopBeforeInline: {
    id: "session.permission.stopBeforeChange.inline",
    message: "Stop the session before changing permission mode.",
  },

  // quick-actions.tsx
  qaClose: { id: "prompt.quickActions.close", message: "Close quick actions" },
  qaOpen: { id: "prompt.quickActions.open", message: "Quick actions" },
  qaUndo: { id: "prompt.quickActions.undo", message: "Undo" },
  qaUndoDesc: { id: "prompt.quickActions.undo.desc", message: "Undo the last message turn" },
  qaRedo: { id: "prompt.quickActions.redo", message: "Redo" },
  qaRedoDesc: { id: "prompt.quickActions.redo.desc", message: "Restore the last undone message turn" },
  qaCompact: { id: "prompt.quickActions.compact", message: "Compact" },
  qaCompactDesc: { id: "prompt.quickActions.compact.desc", message: "Summarize the session to reduce context size" },
  qaInit: { id: "prompt.quickActions.init", message: "Init" },
  qaInitDesc: { id: "prompt.quickActions.init.desc", message: "Initialize project guidance" },
  qaReview: { id: "prompt.quickActions.review", message: "Review" },
  qaReviewDesc: { id: "prompt.quickActions.review.desc", message: "Review recent code changes" },
  qaCommit: { id: "prompt.quickActions.commit", message: "Commit" },
  qaCommitDesc: { id: "prompt.quickActions.commit.desc", message: "Prepare and commit changes" },
  qaRmslop: { id: "prompt.quickActions.rmslop", message: "Rmslop" },
  qaRmslopDesc: { id: "prompt.quickActions.rmslop.desc", message: "Remove AI slop from recent changes" },
  qaNote: { id: "prompt.quickActions.note", message: "Note" },
  qaNoteDesc: { id: "prompt.quickActions.note.desc", message: "Write or update a project note" },
  qaContinue: { id: "prompt.quickActions.continue", message: "Continue" },
  qaContinueDesc: { id: "prompt.quickActions.continue.desc", message: "Continue the current task" },
  qaAudit: { id: "prompt.quickActions.audit", message: "Audit" },
  qaAuditDesc: { id: "prompt.quickActions.audit.desc", message: "Audit the current work" },
  qaStart: { id: "prompt.quickActions.start", message: "Start" },
  qaStartDesc: { id: "prompt.quickActions.start.desc", message: "Start working from current context" },

  // start-options.tsx / add-menu.tsx
  startMode: { id: "prompt.startMode", message: "Start mode" },
  startDefault: { id: "prompt.startDefault", message: "Start" },
  addLabel: { id: "prompt.add", message: "Add" },

  // slash-command-intent.ts
  slashUseTask: { id: "prompt.slash.useTask", message: "Use a task message" },
  slashNoAction: {
    id: "prompt.slash.noAction",
    message: "Light Loop can't start from an action command. Send a task or exit Light Loop.",
  },
  slashNoUi: {
    id: "prompt.slash.noUi",
    message: "Light Loop can't start from a UI command. Send a task or exit Light Loop.",
  },

  // popover.tsx
  popoverNoResults: { id: "prompt.popover.noResults", message: "No matching results" },
  popoverNoCommands: { id: "prompt.popover.noCommands", message: "No matching commands" },
  popoverActionTag: { id: "prompt.popover.actionTag", message: "action" },
  popoverPromptTag: { id: "prompt.popover.promptTag", message: "prompt" },

  // plan-blueprint-offer.tsx
  planOfferAria: { id: "prompt.planOffer.aria", message: "Blueprint ready to equip" },
  planOfferEquipTooltip: {
    id: "prompt.planOffer.equipTooltip",
    message: "Equip this Blueprint in the current composer. Send when you are ready to start it.",
  },
  planOfferEquipAria: { id: "prompt.planOffer.equipAria", message: "Equip Blueprint" },
  planOfferEquip: { id: "prompt.planOffer.equip", message: "Equip" },
  planOfferMuteTooltip: {
    id: "prompt.planOffer.muteTooltip",
    message: "Do not show Blueprint equip offers again until Plan is turned on again.",
  },
  planOfferMuteAria: { id: "prompt.planOffer.muteAria", message: "Do not ask again" },
  planOfferMute: { id: "prompt.planOffer.mute", message: "Don't ask" },
  planOfferDismissTooltip: { id: "prompt.planOffer.dismissTooltip", message: "Dismiss this offer" },
  planOfferDismissAria: { id: "prompt.planOffer.dismissAria", message: "Dismiss Blueprint offer" },

  // attachments-hook.ts
  attachFailedTitle: { id: "prompt.attach.failedTitle", message: "Couldn't attach file" },
  attachFailedGeneric: {
    id: "prompt.attach.failedGeneric",
    message: "This attachment couldn't be prepared. Try another file.",
  },
  attachWaitLightLoop: {
    id: "prompt.attach.waitLightLoop",
    message: "Wait for Light Loop to stop before equipping a Blueprint.",
  },
  attachWaitPlan: { id: "prompt.attach.waitPlan", message: "Wait for Plan to finish before equipping a Blueprint." },
  attachWaitRun: {
    id: "prompt.attach.waitRun",
    message: "Wait for the current session run to finish before equipping a Blueprint.",
  },
  attachSlotOccupied: { id: "prompt.attach.slotOccupied", message: "Blueprint slot occupied" },
  attachWaitCurrentBp: {
    id: "prompt.attach.waitCurrentBp",
    message: "Wait for the current BlueprintLoop to complete before equipping another Blueprint.",
  },
  attachLatticeActive: { id: "prompt.attach.latticeActive", message: "Lattice is active" },
  attachCancelLattice: {
    id: "prompt.attach.cancelLattice",
    message: "Cancel Lattice before equipping a user Blueprint.",
  },
  attachExitPlanFailed: { id: "prompt.attach.exitPlanFailed", message: "Failed to exit Plan" },
  attachExitLightLoopFailed: { id: "prompt.attach.exitLightLoopFailed", message: "Failed to exit Light Loop" },
  attachRequestFailed: { id: "prompt.attach.requestFailed", message: "Request failed" },

  // workflow-menu.ts
  wmRecursiveBpActive: { id: "prompt.wm.recursiveBpActive", message: "Recursive Blueprint run active" },
  wmClickExitLattice: { id: "prompt.wm.clickExitLattice", message: "Click to exit Lattice" },
  wmExitLattice: { id: "prompt.wm.exitLattice", message: "Exit Lattice" },
  wmLatticeUnavailableBp: {
    id: "prompt.wm.latticeUnavailableBp",
    message: "Lattice is unavailable while a Blueprint is equipped",
  },
  wmLatticeUnavailablePlan: {
    id: "prompt.wm.latticeUnavailablePlan",
    message: "Lattice is unavailable while Plan is active",
  },
  wmLatticeUnavailableLl: {
    id: "prompt.wm.latticeUnavailableLl",
    message: "Lattice is unavailable while Light Loop is active",
  },
  wmRunGoal: { id: "prompt.wm.runGoal", message: "Run a goal as a recursive Blueprint" },
  wmStopSessionBeforeWorkflow: {
    id: "prompt.wm.stopSessionBeforeWorkflow",
    message: "Stop the session before changing workflow modes.",
  },

  // placeholders.ts — these are product suggestion text and MUST translate
  placeholderFixTodo: { id: "prompt.placeholder.fixTodo", message: "Fix a TODO in the codebase" },
  placeholderTechStack: { id: "prompt.placeholder.techStack", message: "What is the tech stack of this project?" },
  placeholderFixTests: { id: "prompt.placeholder.fixTests", message: "Fix broken tests" },
  placeholderExplainAuth: { id: "prompt.placeholder.explainAuth", message: "Explain how authentication works" },
  placeholderSecurity: { id: "prompt.placeholder.security", message: "Find and fix security vulnerabilities" },
  placeholderUnitTests: { id: "prompt.placeholder.unitTests", message: "Add unit tests for the user service" },
  placeholderRefactor: { id: "prompt.placeholder.refactor", message: "Refactor this function to be more readable" },
  placeholderErrorMeaning: { id: "prompt.placeholder.errorMeaning", message: "What does this error mean?" },
  placeholderDebug: { id: "prompt.placeholder.debug", message: "Help me debug this issue" },
  placeholderApiDocs: { id: "prompt.placeholder.apiDocs", message: "Generate API documentation" },
  placeholderOptimizeDb: { id: "prompt.placeholder.optimizeDb", message: "Optimize database queries" },
  placeholderValidation: { id: "prompt.placeholder.validation", message: "Add input validation" },
  placeholderNewComponent: { id: "prompt.placeholder.newComponent", message: "Create a new component for..." },
  placeholderDeploy: { id: "prompt.placeholder.deploy", message: "How do I deploy this project?" },
  placeholderCodeReview: { id: "prompt.placeholder.codeReview", message: "Review my code for best practices" },
  placeholderErrorHandling: { id: "prompt.placeholder.errorHandling", message: "Add error handling to this function" },
  placeholderRegex: { id: "prompt.placeholder.regex", message: "Explain this regex pattern" },
  placeholderConvertTs: { id: "prompt.placeholder.convertTs", message: "Convert this to TypeScript" },
  placeholderLogging: { id: "prompt.placeholder.logging", message: "Add logging throughout the codebase" },
  placeholderDeps: { id: "prompt.placeholder.deps", message: "What dependencies are outdated?" },
  placeholderMigration: { id: "prompt.placeholder.migration", message: "Help me write a migration script" },
  placeholderCaching: { id: "prompt.placeholder.caching", message: "Implement caching for this endpoint" },
  placeholderPagination: { id: "prompt.placeholder.pagination", message: "Add pagination to this list" },
  placeholderCliCommand: { id: "prompt.placeholder.cliCommand", message: "Create a CLI command for..." },
  placeholderEnvVars: { id: "prompt.placeholder.envVars", message: "How do environment variables work here?" },
  placeholderGlobal1: { id: "prompt.placeholder.global1", message: "What's on your mind?" },
  placeholderGlobal2: { id: "prompt.placeholder.global2", message: "Help me write an email" },
  placeholderGlobal3: { id: "prompt.placeholder.global3", message: "Summarize this article for me" },
  placeholderGlobal4: { id: "prompt.placeholder.global4", message: "Brainstorm ideas for..." },
  placeholderGlobal5: { id: "prompt.placeholder.global5", message: "Explain quantum computing simply" },
  placeholderGlobal6: { id: "prompt.placeholder.global6", message: "Plan a trip to Tokyo" },
  placeholderGlobal7: { id: "prompt.placeholder.global7", message: "Help me prepare for an interview" },
  placeholderGlobal8: { id: "prompt.placeholder.global8", message: "Draft a blog post about..." },
  placeholderGlobal9: { id: "prompt.placeholder.global9", message: "Compare pros and cons of..." },
  placeholderGlobal10: { id: "prompt.placeholder.global10", message: "Translate this to French" },
}
