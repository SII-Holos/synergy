export const organizationHandoffMessages = {
  actions: { id: "organization.handoff.actions", message: "Conversation actions" },
  refresh: { id: "organization.handoff.refresh", message: "Refresh runtimes" },
  sourceFreeze: {
    id: "organization.handoff.sourceFreeze",
    message: "Waiting for the source to pause and drain its work.",
  },
  targetPrepare: {
    id: "organization.handoff.targetPrepare",
    message: "Waiting for the destination to verify its files and dependencies.",
  },
  targetConsent: {
    id: "organization.handoff.targetConsent",
    message: "Waiting for the destination member to accept this plan.",
  },
  move: { id: "organization.handoff.move", message: "Move conversation" },
  hint: {
    id: "organization.handoff.hint",
    message:
      "Move this conversation and its workspace to another runtime. It will remain paused until you choose Continue.",
  },
  destination: { id: "organization.handoff.destination", message: "Destination" },
  chooseDestination: { id: "organization.handoff.chooseDestination", message: "Choose a runtime" },
  noDestination: {
    id: "organization.handoff.noDestination",
    message: "No other runtime is available. Connect a destination runtime, then refresh.",
  },
  checking: { id: "organization.handoff.checking", message: "Checking the current workspaces…" },
  working: { id: "organization.handoff.working", message: "Updating this move…" },
  workspace: { id: "organization.handoff.workspace", message: "Workspace" },
  native: { id: "organization.handoff.native", message: "Create a private workspace copy" },
  nativeHint: {
    id: "organization.handoff.nativeHint",
    message:
      "Create a separate workspace on the destination. Source files stay in place; existing destination folders are not overwritten.",
  },
  live: { id: "organization.handoff.live", message: "Keep the organization workspace" },
  liveHint: {
    id: "organization.handoff.liveHint",
    message: "Keep the same organization storage and files. No compute is allocated by this move.",
  },
  object: { id: "organization.handoff.object", message: "Copy to organization storage" },
  storage: { id: "organization.handoff.storage", message: "Storage resource" },
  cloudWorkspace: { id: "organization.handoff.cloudWorkspace", message: "Storage workspace" },
  folder: { id: "organization.handoff.folder", message: "Folder" },
  chooseStorage: { id: "organization.handoff.chooseStorage", message: "Choose authorized storage" },
  chooseWorkspace: { id: "organization.handoff.chooseWorkspace", message: "Choose an inactive workspace" },
  noWorkspace: {
    id: "organization.handoff.noWorkspace",
    message: "No inactive workspace is available for this storage resource.",
  },
  path: { id: "organization.handoff.path", message: "New folder in this workspace" },
  source: { id: "organization.handoff.source", message: "From" },
  target: { id: "organization.handoff.target", message: "To" },
  noSource: { id: "organization.handoff.noSource", message: "This conversation has no workspace files." },
  unsupported: {
    id: "organization.handoff.unsupported",
    message: "The current runtimes do not offer a supported workspace move. Refresh after checking their connections.",
  },
  begin: { id: "organization.handoff.begin", message: "Prepare move" },
  preparing: { id: "organization.handoff.preparing", message: "Preparing the move" },
  prepared: { id: "organization.handoff.prepared", message: "Ready to move" },
  surrendered: { id: "organization.handoff.surrendered", message: "Source released; waiting to finish" },
  committed: { id: "organization.handoff.committed", message: "Waiting for the destination" },
  completed: { id: "organization.handoff.completed", message: "Conversation moved and paused" },
  completedHint: {
    id: "organization.handoff.completedHint",
    message: "Close this window and use Continue in the conversation when you are ready to resume.",
  },
  cancelled: { id: "organization.handoff.cancelled", message: "Move cancelled; source remains paused" },
  retired: { id: "organization.handoff.retired", message: "Destination copy retired" },
  waiting: {
    id: "organization.handoff.waiting",
    message: "The destination member must accept this workspace plan before preparation can continue.",
  },
  accept: { id: "organization.handoff.accept", message: "Accept this move" },
  prepareSource: { id: "organization.handoff.prepareSource", message: "Pause and prepare the source" },
  prepareTarget: { id: "organization.handoff.prepareTarget", message: "Prepare the destination" },
  surrender: { id: "organization.handoff.surrender", message: "Release the source" },
  surrenderHint: {
    id: "organization.handoff.surrenderHint",
    message:
      "The source will permanently stop owning this conversation. Its files stay in place. This step cannot be cancelled; the destination will still need activation.",
  },
  commit: { id: "organization.handoff.commit", message: "Finish the move" },
  activate: { id: "organization.handoff.activate", message: "Activate the paused destination" },
  cancel: { id: "organization.handoff.cancel", message: "Cancel move" },
  cancelRequested: {
    id: "organization.handoff.cancelRequested",
    message: "Cancellation has been requested. The source remains paused until it confirms cancellation.",
  },
  finishCancel: { id: "organization.handoff.finishCancel", message: "Confirm source cancellation" },
  cancelHint: {
    id: "organization.handoff.cancelHint",
    message:
      "Request cancellation of this move. The source stays paused until you separately confirm source cancellation.",
  },
  finishCancelHint: {
    id: "organization.handoff.finishCancelHint",
    message:
      "Stop the original preparation and confirm cancellation on its source. The conversation will remain paused.",
  },
  retire: { id: "organization.handoff.retire", message: "Retire destination copy" },
  retireHint: {
    id: "organization.handoff.retireHint",
    message:
      "Permanently prevent this destination copy from activating. The source has already released ownership, so neither copy will resume through this move.",
  },
  check: { id: "organization.handoff.check", message: "Check move status" },
  unknown: {
    id: "organization.handoff.unknown",
    message: "The last operation has no confirmed outcome. Check this move before taking another step.",
  },
  retryPermit: { id: "organization.handoff.retryPermit", message: "Retrieve the original authorization" },
  retryPermitHint: {
    id: "organization.handoff.retryPermitHint",
    message: "Retrieve the same authorization without releasing or activating either runtime.",
  },
  blocked: { id: "organization.handoff.blocked", message: "Preparation needs attention" },
  retryOperation: { id: "organization.handoff.retryOperation", message: "Retry the same operation" },
  moreRequirements: { id: "organization.handoff.moreRequirements", message: "More requirements" },
  history: { id: "organization.handoff.history", message: "Existing moves" },
  historyHint: {
    id: "organization.handoff.historyHint",
    message: "Inspect an existing move to recover its original progress.",
  },
  ownerHint: {
    id: "organization.handoff.ownerHint",
    message: "The current runtime owner can start a move. Destination members can accept their existing moves here.",
  },
  progress: { id: "organization.handoff.progress", message: "Transferred {bytes} bytes" },
  close: { id: "organization.handoff.close", message: "Close" },
}
