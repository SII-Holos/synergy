import type { MessageDescriptor } from "@lingui/core"

/**
 * Explicit Lingui runtime message descriptors.
 *
 * Each descriptor provides an `id` (stable extraction key) and the English
 * `message` (source text / fallback). Components use `<Trans>` for JSX content
 * and the active Lingui runtime for imperative strings.
 */

export type AppMessageDescriptor = MessageDescriptor

// ── Workspace core ───────────────────────────────────────────────────────────

export const workspace = {
  panelUnavailable: { id: "app.workspace.panel.unavailable", message: "Panel unavailable" },
  closeTab: { id: "app.workspace.tab.close", message: "Close {title}" },
  noSidePanels: { id: "app.workspace.launcher.noSidePanels", message: "No side panels available" },
  noBottomPanels: { id: "app.workspace.launcher.noBottomPanels", message: "No bottom panels available" },
  openNewTab: { id: "app.workspace.launcher.openNewTab", message: "Open a new tab" },
  openPanel: { id: "app.workspace.launcher.openPanel", message: "Open panel" },
  sideWorkspace: { id: "app.workspace.surface.side", message: "Side workspace" },
  bottomWorkspace: { id: "app.workspace.surface.bottom", message: "Bottom workspace" },
  sideTabs: { id: "app.workspace.tabs.side", message: "Side workspace tabs" },
  bottomTabs: { id: "app.workspace.tabs.bottom", message: "Bottom workspace tabs" },
  addSidePanel: { id: "app.workspace.add.sidePanel", message: "Add side panel" },
  addBottomPanel: { id: "app.workspace.add.bottomPanel", message: "Add bottom panel" },
  mobileHeader: { id: "app.workspace.mobileHeader", message: "Workspace" },
  closeWorkspace: { id: "app.workspace.mobileHeader.close", message: "Close workspace" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Builtin panel labels ─────────────────────────────────────────────────────

export const panels = {
  notes: { id: "app.panel.notes", message: "Notes" },
  context: { id: "app.panel.context", message: "Context" },
  review: { id: "app.panel.review", message: "Review" },
  files: { id: "app.panel.files", message: "Files" },
  openFile: { id: "app.panel.files.openFile", message: "Open file" },
  browser: { id: "app.panel.browser", message: "Browser" },
  terminal: { id: "app.panel.terminal", message: "Terminal" },
} as const satisfies Record<string, AppMessageDescriptor>

export const contextWorkspace = {
  categoryConversation: { id: "app.context.category.conversation", message: "Conversation" },
  categoryConversationDescription: {
    id: "app.context.category.conversation.description",
    message: "User and assistant text, including reasoning",
  },
  categoryToolActivity: { id: "app.context.category.toolActivity", message: "Tool activity" },
  categoryToolActivityDescription: {
    id: "app.context.category.toolActivity.description",
    message: "Tool definitions, calls, results, and errors",
  },
  categoryFilesReferences: { id: "app.context.category.filesReferences", message: "Files and references" },
  categoryFilesReferencesDescription: {
    id: "app.context.category.filesReferences.description",
    message: "Attachments, file summaries, and provider-file references",
  },
  categoryInstructions: { id: "app.context.category.instructions", message: "Instructions" },
  categoryInstructionsDescription: {
    id: "app.context.category.instructions.description",
    message: "Agent, project, workflow, memory, and runtime guidance",
  },
  categoryOverhead: { id: "app.context.category.overhead", message: "Overhead" },
  categoryOverheadDescription: {
    id: "app.context.category.overhead.description",
    message: "Provider formatting, opaque file usage, and estimation variance",
  },
  statusPartiallyKnown: { id: "app.context.status.partiallyKnown", message: "Context size is partially known" },
  statusCompacting: { id: "app.context.status.compacting", message: "Compacting conversation…" },
  statusCompacted: {
    id: "app.context.status.compacted",
    message: "Conversation compacted; usage available after the next response",
  },
  statusCritical: { id: "app.context.status.critical", message: "Very little context space remains" },
  statusWarning: { id: "app.context.status.warning", message: "This context is getting full" },
  statusReady: { id: "app.context.status.ready", message: "Enough room to continue" },
  untitledSession: { id: "app.context.session.untitled", message: "Untitled session" },
  usedInput: { id: "app.context.usage.usedInput", message: "Used input" },
  contextLimitUnknown: { id: "app.context.usage.limitUnknown", message: "Context limit unknown" },
  percentUsed: { id: "app.context.usage.percentUsed", message: "{percent} used" },
  tokensRemaining: { id: "app.context.usage.tokensRemaining", message: "{tokens} remaining" },
  modelLabel: { id: "app.context.model.label", message: "Model {model}" },
  compactHint: { id: "app.context.compact.hint", message: "Compact the conversation to recover context space." },
  compactAction: { id: "app.context.compact.action", message: "Compact conversation" },
  breakdownTitle: { id: "app.context.breakdown.title", message: "What’s taking space" },
  breakdownUnavailable: {
    id: "app.context.breakdown.unavailable",
    message: "Breakdown available after the next response",
  },
  itemCount: { id: "app.context.breakdown.itemCount", message: "{count, plural, one {# item} other {# items}}" },
  estimatedTokens: { id: "app.context.breakdown.estimatedTokens", message: "Estimated {tokens}" },
  exactInputShare: { id: "app.context.breakdown.exactInputShare", message: "{percent} of exact input" },
  estimateNote: {
    id: "app.context.breakdown.estimateNote",
    message: "Category values are model-tokenizer estimates reconciled to the exact provider input total.",
  },
  usageDetails: { id: "app.context.details.usage", message: "Usage details" },
  provider: { id: "app.context.details.provider", message: "Provider" },
  model: { id: "app.context.details.model", message: "Model" },
  contextWindow: { id: "app.context.details.contextWindow", message: "Context window" },
  contextUsage: { id: "app.context.details.contextUsage", message: "Context usage" },
  remainingInput: { id: "app.context.details.remainingInput", message: "Remaining input" },
  latestCallTotal: { id: "app.context.details.latestCallTotal", message: "Latest-call total" },
  latestOutputReasoning: { id: "app.context.details.latestOutputReasoning", message: "Latest output / reasoning" },
  cacheReadWrite: { id: "app.context.details.cacheReadWrite", message: "Cache read / write" },
  latestCallCost: { id: "app.context.details.latestCallCost", message: "Latest-call cost" },
  loadedMessagesCost: { id: "app.context.details.loadedMessagesCost", message: "Loaded messages cost" },
  dataAccess: { id: "app.context.dataAccess.title", message: "Data access" },
  dataAccessDescription: {
    id: "app.context.dataAccess.description",
    message: "Inspect normalized persisted messages and the latest user system override.",
  },
  rawMessages: { id: "app.context.dataAccess.rawMessages", message: "View raw messages" },
  latestUserSystemOverride: {
    id: "app.context.instructions.latestUserOverride",
    message: "Latest user system override",
  },
  noSystemInstructions: { id: "app.context.instructions.empty", message: "No user system override is available." },
  copySystemInstructions: { id: "app.context.instructions.copy", message: "Copy user system override" },
  copySystemInstructionsFailed: {
    id: "app.context.instructions.copyFailed",
    message: "Unable to copy user system override.",
  },
  copy: { id: "app.context.action.copy", message: "Copy" },
  copied: { id: "app.context.action.copied", message: "Copied" },
  copyFailed: { id: "app.context.action.copyFailed", message: "Copy failed" },
  developerDetails: { id: "app.context.developer.title", message: "Developer details" },
  sessionTitle: { id: "app.context.developer.sessionTitle", message: "Session title" },
  sessionID: { id: "app.context.developer.sessionID", message: "Session ID" },
  messages: { id: "app.context.developer.messages", message: "Messages" },
  userMessages: { id: "app.context.developer.userMessages", message: "User messages" },
  assistantMessages: { id: "app.context.developer.assistantMessages", message: "Assistant messages" },
  sessionCreated: { id: "app.context.developer.sessionCreated", message: "Session created" },
  lastActivity: { id: "app.context.developer.lastActivity", message: "Last activity" },
  estimatorKind: { id: "app.context.developer.estimatorKind", message: "Estimator kind" },
  estimatorEncoding: { id: "app.context.developer.estimatorEncoding", message: "Estimator encoding" },
  reconciliationMode: { id: "app.context.developer.reconciliationMode", message: "Reconciliation mode" },
  reconciliationFactor: { id: "app.context.developer.reconciliationFactor", message: "Reconciliation factor" },
  rawEstimatedTotal: { id: "app.context.developer.rawEstimatedTotal", message: "Raw estimated total" },
  attributedTotal: { id: "app.context.developer.attributedTotal", message: "Attributed total" },
  estimatedAttributed: {
    id: "app.context.developer.estimatedAttributed",
    message: "{category} estimated / attributed",
  },
} as const satisfies Record<string, AppMessageDescriptor>

export const rawMessages = {
  title: { id: "app.rawMessages.title", message: "Raw messages" },
  sensitiveNotice: {
    id: "app.rawMessages.notice.sensitive",
    message: "May include prompts, tool inputs, file contents, and model output. Copy carefully.",
  },
  selectAll: { id: "app.rawMessages.selection.selectAll", message: "Select all loaded messages" },
  messageCount: { id: "app.rawMessages.count", message: "{count, plural, one {# message} other {# messages}}" },
  copySelected: { id: "app.rawMessages.copy.selected", message: "Copy selected raw messages" },
  copySelectedFailed: {
    id: "app.rawMessages.copy.selectedFailed",
    message: "Unable to copy selected raw session messages.",
  },
  copyCurrent: { id: "app.rawMessages.copy.current", message: "Copy current message" },
  copyCurrentFailed: {
    id: "app.rawMessages.copy.currentFailed",
    message: "Unable to copy the current raw session message.",
  },
  copied: { id: "app.rawMessages.copy.copied", message: "Copied" },
  copyFailed: { id: "app.rawMessages.copy.failed", message: "Copy failed" },
  copySelectedCount: {
    id: "app.rawMessages.copy.selectedCount",
    message: "Copy {count, plural, one {# selected message} other {# selected messages}}",
  },
  clearSelection: { id: "app.rawMessages.selection.clear", message: "Clear selection" },
  refresh: { id: "app.rawMessages.refresh", message: "Refresh raw messages" },
  refreshShort: { id: "app.rawMessages.refresh.short", message: "Refresh" },
  listLabel: { id: "app.rawMessages.list.label", message: "Raw session messages" },
  loadError: { id: "app.rawMessages.error.load", message: "Couldn’t load messages." },
  retry: { id: "app.rawMessages.retry", message: "Retry" },
  loading: { id: "app.rawMessages.loading", message: "Loading…" },
  empty: { id: "app.rawMessages.empty", message: "No messages." },
  selectMessage: { id: "app.rawMessages.selection.message", message: "Select {role} {id}" },
  roleUser: { id: "app.rawMessages.role.user", message: "User" },
  roleAssistant: { id: "app.rawMessages.role.assistant", message: "Assistant" },
  flagHidden: { id: "app.rawMessages.flag.hidden", message: "Hidden" },
  flagExcluded: { id: "app.rawMessages.flag.excluded", message: "Excluded" },
  loadEarlier: { id: "app.rawMessages.loadEarlier", message: "Load earlier" },
  backToMessages: { id: "app.rawMessages.back", message: "Messages" },
  chooseMessage: { id: "app.rawMessages.preview.empty", message: "Choose a message to inspect." },
  wrapLines: { id: "app.rawMessages.preview.wrap", message: "Wrap lines" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Browser ──────────────────────────────────────────────────────────────────

export const browser = {
  ready: { id: "app.browser.empty.ready", message: "Browser ready" },
  waitingForSurface: { id: "app.browser.empty.waiting", message: "Waiting for the page surface." },
  connecting: { id: "app.browser.connecting", message: "Connecting to Browser" },
  bootstrapFailed: { id: "app.browser.error.bootstrapFailed", message: "Browser session could not be loaded" },
  unavailable: { id: "app.browser.error.unavailable", message: "Browser unavailable" },
  issue: { id: "app.browser.error.issue", message: "Browser issue" },
  dismiss: { id: "app.browser.error.dismiss", message: "Dismiss" },
  disconnected: { id: "app.browser.disconnected", message: "Browser disconnected" },
  retry: { id: "app.browser.retry", message: "Retry" },
  noPage: { id: "app.browser.empty.noPage", message: "No page open" },
  nextNavigation: { id: "app.browser.empty.nextNavigation", message: "The next navigation will appear here." },
  chooseFile: { id: "app.browser.upload.chooseFile", message: "Choose file for upload" },
  chooseFilesDescription: {
    id: "app.browser.upload.description",
    message: "The page requested {count, plural, one {a file} other {one or more files}}.",
  },
  cancel: { id: "app.browser.action.cancel", message: "Cancel" },
  choose: { id: "app.browser.action.choose", message: "Choose" },
  ok: { id: "app.browser.action.ok", message: "OK" },
  uploadTooLarge: {
    id: "app.browser.error.uploadTooLarge",
    message: "Choose at most 20 files, no more than 25 MB each and 50 MB total.",
  },
  // ── Address bar ──
  navBack: { id: "app.browser.nav.back", message: "Back" },
  navForward: { id: "app.browser.nav.forward", message: "Forward" },
  stop: { id: "app.browser.nav.stop", message: "Stop" },
  reload: { id: "app.browser.nav.reload", message: "Reload" },
  enterUrl: { id: "app.browser.address.placeholder", message: "Enter URL or search" },
  options: { id: "app.browser.menu.options", message: "Browser options" },
  controls: { id: "app.browser.menu.controls", message: "Browser controls" },
  followAgent: { id: "app.browser.menu.followAgent", message: "Follow agent" },
  agentNavigation: { id: "app.browser.menu.agentNavigation", message: "Agent navigation" },
  viewport: { id: "app.browser.menu.viewport", message: "Viewport" },
  fit: { id: "app.browser.viewport.fit", message: "Fit" },
  panels: { id: "app.browser.menu.panels", message: "Panels" },
  // ── Dev panels ──
  devConsole: { id: "app.browser.dev.console", message: "Console" },
  devConsoleDesc: { id: "app.browser.dev.console.description", message: "Page logs" },
  devNetwork: { id: "app.browser.dev.network", message: "Network" },
  devNetworkDesc: { id: "app.browser.dev.network.description", message: "Requests" },
  devElements: { id: "app.browser.dev.elements", message: "Elements" },
  devElementsDesc: { id: "app.browser.dev.elements.description", message: "Snapshot" },
  devAssets: { id: "app.browser.dev.assets", message: "Assets" },
  devAssetsDesc: { id: "app.browser.dev.assets.description", message: "Page files" },
  devDownloads: { id: "app.browser.dev.downloads", message: "Downloads" },
  devDownloadsDesc: { id: "app.browser.dev.downloads.description", message: "Saved files" },
  clearDiagnostics: { id: "app.browser.menu.clearDiagnostics", message: "Clear diagnostics" },
  capturedLogs: { id: "app.browser.menu.capturedLogs", message: "Captured logs" },
  openLocal: { id: "app.browser.menu.openLocal", message: "Open local" },
  open: { id: "app.browser.menu.open", message: "Open" },
  // ── Viewport ──
  viewportWidth: { id: "app.browser.viewport.width", message: "Viewport width" },
  viewportHeight: { id: "app.browser.viewport.height", message: "Viewport height" },
  applyViewport: { id: "app.browser.viewport.apply", message: "Apply viewport size" },
  apply: { id: "app.browser.viewport.apply.label", message: "Apply" },
  presetDesktop: { id: "app.browser.viewport.preset.desktop", message: "Desktop" },
  presetTablet: { id: "app.browser.viewport.preset.tablet", message: "Tablet" },
  presetMobile: { id: "app.browser.viewport.preset.mobile", message: "Mobile" },
  // ── Agent ──
  agentActivity: { id: "app.browser.agent.activity", message: "Agent {kind} {host}" },
  follow: { id: "app.browser.agent.follow", message: "Follow" },
  // ── Annotation ──
  annotationPlaceholder: { id: "app.browser.annotation.placeholder", message: "Add a comment about this element..." },
  styleFeedback: { id: "app.browser.annotation.styleFeedback", message: "Style feedback" },
  hideStyle: { id: "app.browser.annotation.hideStyle", message: "Hide style" },
  annotationSend: { id: "app.browser.annotation.send", message: "Send" },
  size: { id: "app.browser.annotation.size", message: "Size" },
  color: { id: "app.browser.annotation.color", message: "Color" },
  // ── Remote browser ──
  remoteTextInput: { id: "app.browser.remote.textInput", message: "Remote browser text input" },
  // ── Remote browser status ──
  remoteWaiting: { id: "app.browser.remote.status.waiting", message: "Waiting for Browser Host" },
  remotePreparing: { id: "app.browser.remote.status.preparing", message: "Preparing remote browser" },
  remoteStreamPreparing: {
    id: "app.browser.remote.status.streamPreparing",
    message: "Preparing remote browser stream",
  },
  remoteNegotiating: {
    id: "app.browser.remote.status.negotiating",
    message: "Negotiating remote browser stream",
  },
  remoteConnecting: { id: "app.browser.remote.status.connecting", message: "Connecting to remote browser" },
  remoteUnavailable: { id: "app.browser.remote.status.unavailable", message: "Remote browser stream unavailable" },
  viewportWidthPlaceholder: { id: "app.browser.viewport.width.placeholder", message: "W" },
  viewportHeightPlaceholder: { id: "app.browser.viewport.height.placeholder", message: "H" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Browser panel empty states ───────────────────────────────────────────────

export const consolePanel = {
  empty: { id: "app.browser.console.empty", message: "No console entries" },
} as const satisfies Record<string, AppMessageDescriptor>

export const networkPanel = {
  empty: { id: "app.browser.network.empty", message: "No network requests" },
  statusCol: { id: "app.browser.network.column.status", message: "Status" },
  methodCol: { id: "app.browser.network.column.method", message: "Method" },
  typeCol: { id: "app.browser.network.column.type", message: "Type" },
  urlCol: { id: "app.browser.network.column.url", message: "URL" },
} as const satisfies Record<string, AppMessageDescriptor>

export const elementsPanel = {
  empty: { id: "app.browser.elements.empty", message: "Request a snapshot to inspect elements" },
} as const satisfies Record<string, AppMessageDescriptor>

export const downloadsPanel = {
  empty: { id: "app.browser.downloads.empty", message: "No downloads" },
  stateCol: { id: "app.browser.downloads.column.state", message: "State" },
  fileCol: { id: "app.browser.downloads.column.file", message: "File" },
  sizeCol: { id: "app.browser.downloads.column.size", message: "Size" },
  urlCol: { id: "app.browser.downloads.column.url", message: "URL" },
  timeCol: { id: "app.browser.downloads.column.time", message: "Time" },
  stateDownloading: { id: "app.browser.downloads.state.downloading", message: "Downloading" },
  stateComplete: { id: "app.browser.downloads.state.complete", message: "Complete" },
  stateCancelled: { id: "app.browser.downloads.state.cancelled", message: "Cancelled" },
  stateInterrupted: { id: "app.browser.downloads.state.interrupted", message: "Interrupted" },
  stateBlocked: { id: "app.browser.downloads.state.blocked", message: "Blocked" },
} as const satisfies Record<string, AppMessageDescriptor>

export const assetsPanel = {
  empty: { id: "app.browser.assets.empty", message: "No page assets" },
  typeImages: { id: "app.browser.assets.type.images", message: "Images" },
  typeScripts: { id: "app.browser.assets.type.scripts", message: "Scripts" },
  typeStylesheets: { id: "app.browser.assets.type.stylesheets", message: "Stylesheets" },
  typeFonts: { id: "app.browser.assets.type.fonts", message: "Fonts" },
  typeMedia: { id: "app.browser.assets.type.media", message: "Media" },
  typeDocuments: { id: "app.browser.assets.type.documents", message: "Documents" },
  typeOther: { id: "app.browser.assets.type.other", message: "Other" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── File workbench ───────────────────────────────────────────────────────────

export const fileWorkbench = {
  openAFile: { id: "app.file.empty.openAFile", message: "Open a file" },
  chooseFromTree: { id: "app.file.empty.chooseFromTree", message: "Choose a file from the workspace tree." },
  loading: { id: "app.file.loading", message: "Loading {path}…" },
  unableToOpen: { id: "app.file.error.unableToOpen", message: "Unable to open file" },
  retry: { id: "app.file.action.retry", message: "Retry" },
  close: { id: "app.file.action.close", message: "Close" },
  fileDeleted: { id: "app.file.banner.deleted", message: "File was deleted. Showing the last available content." },
  fileTruncated: { id: "app.file.banner.truncated", message: "Showing the first 512 KiB of this file." },
  binaryInfo: { id: "app.file.binary.info", message: "{mimeType} · {bytes} bytes" },
  addToContext: { id: "app.file.toolbar.addToContext", message: "Add to context" },
  viewMode: { id: "app.file.toolbar.viewMode", message: "File view mode" },
  filePath: { id: "app.file.breadcrumb.label", message: "File path" },
  source: { id: "app.file.mode.source", message: "Source" },
  preview: { id: "app.file.mode.preview", message: "Preview" },
  toggleFileTree: { id: "app.file.toolbar.toggleFileTree", message: "Toggle file tree" },
  zoomOut: { id: "app.file.image.zoomOut", message: "Zoom out" },
  zoomIn: { id: "app.file.image.zoomIn", message: "Zoom in" },
  fit: { id: "app.file.image.fit", message: "Fit" },
  loadingSourceViewer: { id: "app.file.loading.sourceViewer", message: "Loading source viewer…" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── File explorer ────────────────────────────────────────────────────────────

export const fileExplorer = {
  label: { id: "app.fileExplorer.label", message: "Files" },
  workspaceFiles: { id: "app.fileExplorer.tree.label", message: "Workspace files" },
  showHidden: { id: "app.fileExplorer.action.showHidden", message: "Show hidden and ignored files" },
  refresh: { id: "app.fileExplorer.action.refresh", message: "Refresh files" },
  collapseAll: { id: "app.fileExplorer.action.collapseAll", message: "Collapse all folders" },
  closeTree: { id: "app.fileExplorer.action.closeTree", message: "Close file tree" },
  searchPlaceholder: { id: "app.fileExplorer.search.placeholder", message: "Search files" },
  searchLabel: { id: "app.fileExplorer.search.label", message: "Search files" },
  hiddenNotice: { id: "app.fileExplorer.hidden.notice", message: "The active file is hidden by Explorer filters." },
  showIt: { id: "app.fileExplorer.hidden.showIt", message: "Show it" },
  loadingMore: { id: "app.fileExplorer.loadingMore", message: "Loading more…" },
  retryLoadingFolder: { id: "app.fileExplorer.error.retryLoadingFolder", message: "Retry loading folder" },
  loading: { id: "app.fileExplorer.loading", message: "Loading…" },
  noMatchingFiles: { id: "app.fileExplorer.search.noMatchingFiles", message: "No matching files" },
  searchResults: { id: "app.fileExplorer.search.results.label", message: "File search results" },
  symbolicLink: { id: "app.fileExplorer.tree.symbolicLink", message: "Symbolic link" },
  title: { id: "app.fileExplorer.title", message: "Files" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Terminal ─────────────────────────────────────────────────────────────────

export const terminal = {
  loading: { id: "app.terminal.loading", message: "Loading terminal..." },
  closed: { id: "app.terminal.closed", message: "Terminal closed" },
  sessionLost: { id: "app.terminal.sessionLost", message: "Session lost" },
  reconnecting: { id: "app.terminal.reconnecting", message: "Reconnecting..." },
  copySelection: { id: "app.terminal.copySelection", message: "Copy terminal selection" },
  copyFailed: { id: "app.terminal.copyFailed", message: "Unable to copy the terminal selection." },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Session review ───────────────────────────────────────────────────────────

export const sessionReview = {
  loading: { id: "app.sessionReview.loading", message: "Loading changes…" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Note panel ───────────────────────────────────────────────────────────────

export const note = {
  untitled: { id: "app.note.untitled", message: "Untitled" },
  // Blueprint status
  runQueued: { id: "app.note.blueprint.status.armed", message: "Run queued" },
  running: { id: "app.note.blueprint.status.running", message: "Running" },
  needsInput: { id: "app.note.blueprint.status.waiting", message: "Needs input" },
  reviewing: { id: "app.note.blueprint.status.auditing", message: "Reviewing" },
  completed: { id: "app.note.blueprint.status.completed", message: "Completed" },
  failed: { id: "app.note.blueprint.status.failed", message: "Failed" },
  cancelled: { id: "app.note.blueprint.status.cancelled", message: "Cancelled" },
  // Run modes
  sessionRun: { id: "app.note.blueprint.runMode.session", message: "Session run" },
  newSession: { id: "app.note.blueprint.runMode.new", message: "New session" },
  worktreeRun: { id: "app.note.blueprint.runMode.worktree", message: "Worktree run" },
  activeRun: { id: "app.note.blueprint.runMode.active", message: "Active run" },
  // States
  runFailed: { id: "app.note.blueprint.state.runFailed", message: "Run failed" },
  lastRunFailed: { id: "app.note.blueprint.state.lastRunFailed", message: "Last run failed" },
  blueprint: { id: "app.note.blueprint.state.label", message: "Blueprint" },
  noActiveRun: { id: "app.note.blueprint.state.noActiveRun", message: "No active run" },
  // Card
  fromOrigin: { id: "app.note.card.from", message: "From {name}" },
  runHistory: { id: "app.note.card.runHistory", message: "Run history" },
  runsCount: { id: "app.note.card.runsCount", message: "{count, plural, one {# run} other {# runs}}" },
  noRunsYet: { id: "app.note.card.noRunsYet", message: "No runs yet" },
  // Run menu / models
  runBlueprint: { id: "app.note.run.blueprint", message: "Run Blueprint" },
  run: { id: "app.note.run.label", message: "Run" },
  runWithSelectedModel: { id: "app.note.run.withSelectedModel", message: "Run with selected model" },
  selectModel: { id: "app.note.run.selectModel", message: "Select model" },
  searchModels: { id: "app.note.run.searchModels", message: "Search models" },
  model: { id: "app.note.run.model", message: "Model" },
  modelChooseHelp: {
    id: "app.note.run.modelChooseHelp",
    message: "Choose a specific model, or keep automatic fallback.",
  },
  chooseModel: { id: "app.note.run.chooseModel", message: "Choose model for Blueprint run" },
  useFallback: { id: "app.note.run.useFallback", message: "Use fallback" },
  useFallbackDesc: { id: "app.note.run.useFallbackDesc", message: "Let the agent pick the best model automatically." },
  currentSession: { id: "app.note.run.currentSession", message: "Current session" },
  currentSessionDesc: { id: "app.note.run.currentSessionDesc", message: "Run in the session you are viewing." },
  currentSessionHint: {
    id: "app.note.run.currentSessionHint",
    message: "Open a session in this Blueprint scope first.",
  },
  newSessionRun: { id: "app.note.run.newSession", message: "New session" },
  newSessionDesc: {
    id: "app.note.run.newSessionDesc",
    message: "Create a fresh session in this scope and start immediately.",
  },
  newWorktreeSession: { id: "app.note.run.worktreeSession", message: "New worktree session" },
  worktreeDesc: {
    id: "app.note.run.worktreeDesc",
    message: "Create an isolated worktree session and start immediately.",
  },
  worktreeHint: { id: "app.note.run.worktreeHint", message: "Worktree runs require a git project scope." },
  // Toolbar
  back: { id: "app.note.toolbar.back", message: "Back" },
  backToSession: { id: "app.note.toolbar.backToSession", message: "Back to session mode" },
  close: { id: "app.note.toolbar.close", message: "Close" },
  closeRunMenu: { id: "app.note.toolbar.closeRunMenu", message: "Close run menu" },
  newNote: { id: "app.note.toolbar.newNote", message: "New note" },
  viewAll: { id: "app.note.toolbar.viewAll", message: "View all" },
  notes: { id: "app.note.toolbar.notes", message: "notes" },
  noNotes: { id: "app.note.toolbar.noNotes", message: "No notes in this scope" },
  searchNotes: { id: "app.note.toolbar.searchNotes", message: "Search notes..." },
  clearSearch: { id: "app.note.toolbar.clearSearch", message: "Clear search" },
  current: { id: "app.note.toolbar.current", message: "Current" },
  // Bulk
  selected: { id: "app.note.bulk.selected", message: "selected" },
  selectAll: { id: "app.note.bulk.selectAll", message: "Select all" },
  selectNotes: { id: "app.note.bulk.selectNotes", message: "Select notes" },
  archive: { id: "app.note.bulk.archive", message: "Archive" },
  restore: { id: "app.note.bulk.restore", message: "Restore" },
  deletePermanently: { id: "app.note.bulk.delete", message: "Delete permanently" },
  cancel: { id: "app.note.bulk.cancel", message: "Cancel" },
  noNotesFound: { id: "app.note.bulk.noNotesFound", message: "No notes found" },
  refresh: { id: "app.note.bulk.refresh", message: "Refresh" },
  // Filters
  filterAll: { id: "app.note.filter.all", message: "All" },
  filterNotes: { id: "app.note.filter.notes", message: "Notes" },
  filterBlueprints: { id: "app.note.filter.blueprints", message: "Blueprints" },
  showActive: { id: "app.note.filter.showActive", message: "Show active" },
  showArchived: { id: "app.note.filter.showArchived", message: "Show archived" },
  // Editor header
  backToList: { id: "app.note.editor.backToList", message: "Back to list" },
  unpin: { id: "app.note.editor.unpin", message: "Unpin" },
  pin: { id: "app.note.editor.pin", message: "Pin" },
  makeLocal: { id: "app.note.editor.makeLocal", message: "Make local" },
  makeGlobal: { id: "app.note.editor.makeGlobal", message: "Make global" },
  downloadMarkdown: { id: "app.note.editor.downloadMarkdown", message: "Download as Markdown" },
  convertToNote: { id: "app.note.editor.convertToNote", message: "Convert to Note" },
  convertToBlueprint: { id: "app.note.editor.convertToBlueprint", message: "Convert to Blueprint" },
  // Detail panel
  lastActivity: { id: "app.note.detail.lastActivity", message: "Last activity" },
  openSession: { id: "app.note.detail.openSession", message: "Open session" },
  reloadRemote: { id: "app.note.detail.reloadRemote", message: "Reload remote" },
  overwriteRemote: { id: "app.note.detail.overwriteRemote", message: "Overwrite remote" },
  addTags: { id: "app.note.detail.addTags", message: "Add tags..." },
  deleteNote: { id: "app.note.editor.deleteNote", message: "Delete note" },
  keepMine: { id: "app.note.detail.keepMine", message: "Keep mine" },
  downloadNote: { id: "app.note.editor.downloadNote", message: "Download note" },
  pinnedState: { id: "app.note.editor.pinnedState", message: "Pinned" },
  local: { id: "app.note.editor.local", message: "Local" },
  global: { id: "app.note.editor.global", message: "Global" },
  toNote: { id: "app.note.editor.toNote", message: "To Note" },
  toBlueprint: { id: "app.note.editor.toBlueprint", message: "To Blueprint" },
  noModelResults: { id: "app.note.run.noModelResults", message: "No model results" },
  viewAllNotes: { id: "app.note.toolbar.viewAllNotes", message: "View all {count} notes" },
  noteCountLabel: { id: "app.note.card.noteCountLabel", message: "{count, plural, one {# note} other {# notes}}" },
  addTag: { id: "app.note.detail.addTag", message: "Add tag" },
  separator: { id: "app.note.separator.dot", message: " · " },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Note bubble menu ─────────────────────────────────────────────────────────

export const bubbleMenu = {
  bold: { id: "app.note.bubble.bold", message: "Bold" },
  italic: { id: "app.note.bubble.italic", message: "Italic" },
  strikethrough: { id: "app.note.bubble.strikethrough", message: "Strikethrough" },
  code: { id: "app.note.bubble.code", message: "Code" },
  link: { id: "app.note.bubble.link", message: "Link" },
  latex: { id: "app.note.bubble.formula.latex", message: "LaTeX" },
  toggleBlockFormula: { id: "app.note.bubble.formula.toggleBlock", message: "Toggle block formula" },
  block: { id: "app.note.bubble.formula.block", message: "Block" },
  inline: { id: "app.note.bubble.formula.inline", message: "Inline" },
  deleteFormula: { id: "app.note.bubble.formula.delete", message: "Delete formula" },
  delete: { id: "app.note.bubble.formula.deleteLabel", message: "Delete" },
  finishEditing: { id: "app.note.bubble.formula.finishEditing", message: "Finish editing formula" },
  done: { id: "app.note.bubble.formula.done", message: "Done" },
  escHint: { id: "app.note.bubble.formula.escHint", message: "Esc moves the cursor after the formula" },
  ctrlEnterHint: { id: "app.note.bubble.formula.ctrlEnterHint", message: "⌘/Ctrl + Enter also works" },
  addRowBefore: { id: "app.note.bubble.table.addRowBefore", message: "Add row before" },
  addRowAfter: { id: "app.note.bubble.table.addRowAfter", message: "Add row after" },
  addColumnBefore: { id: "app.note.bubble.table.addColumnBefore", message: "Add column before" },
  addColumnAfter: { id: "app.note.bubble.table.addColumnAfter", message: "Add column after" },
  deleteRow: { id: "app.note.bubble.table.deleteRow", message: "Delete row" },
  deleteColumn: { id: "app.note.bubble.table.deleteColumn", message: "Delete column" },
  deleteTable: { id: "app.note.bubble.table.deleteTable", message: "Delete table" },
  mergeCells: { id: "app.note.bubble.table.mergeCells", message: "Merge cells" },
  splitCell: { id: "app.note.bubble.table.splitCell", message: "Split cell" },
  toggleHeaderRow: { id: "app.note.bubble.table.toggleHeaderRow", message: "Toggle header row" },
  boldSymbol: { id: "app.note.bubble.symbol.bold", message: "B" },
  italicSymbol: { id: "app.note.bubble.symbol.italic", message: "I" },
  strikethroughSymbol: { id: "app.note.bubble.symbol.strikethrough", message: "S" },
  codeSymbol: { id: "app.note.bubble.symbol.code", message: "<>" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Note slash menu ──────────────────────────────────────────────────────────

export const slashMenu = {
  h1: { id: "app.note.slash.h1", message: "H1" },
  h2: { id: "app.note.slash.h2", message: "H2" },
  h3: { id: "app.note.slash.h3", message: "H3" },
  list: { id: "app.note.slash.list", message: "List" },
  num: { id: "app.note.slash.num", message: "Num" },
  task: { id: "app.note.slash.task", message: "Task" },
  code: { id: "app.note.slash.code", message: "Code" },
  quote: { id: "app.note.slash.quote", message: "Quote" },
  line: { id: "app.note.slash.line", message: "Line" },
  image: { id: "app.note.slash.image", message: "Image" },
  video: { id: "app.note.slash.video", message: "Video" },
  table: { id: "app.note.slash.table", message: "Table" },
  deleteTable: { id: "app.note.slash.deleteTable", message: "Delete Table" },
  addRowBelow: { id: "app.note.slash.addRowBelow", message: "Add Row Below" },
  addColumnRight: { id: "app.note.slash.addColumnRight", message: "Add Column Right" },
  deleteRow: { id: "app.note.slash.deleteRow", message: "Delete Row" },
  deleteColumn: { id: "app.note.slash.deleteColumn", message: "Delete Column" },
  mergeCells: { id: "app.note.slash.mergeCells", message: "Merge Cells" },
  splitCell: { id: "app.note.slash.splitCell", message: "Split Cell" },
  math: { id: "app.note.slash.math", message: "Math" },
  diagram: { id: "app.note.slash.diagram", message: "Diagram" },
  insert: { id: "app.note.slash.category.insert", message: "Insert" },
  tableCategory: { id: "app.note.slash.category.table", message: "Table" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Note document editor ─────────────────────────────────────────────────────

export const docEditor = {
  slashHint: { id: "app.note.editor.slashHint", message: "Type / for commands..." },
  saving: { id: "app.note.editor.saving", message: "Saving..." },
} as const satisfies Record<string, AppMessageDescriptor>

// ── All descriptors (for convenience / barrel re-exports) ─────────────────────

// ── App Shell ────────────────────────────────────────────────────────────────

export const appShell = {
  // Connection banner
  connectionLost: { id: "app.shell.connection.lost", message: "Connection lost — check your network" },
  reconnecting: { id: "app.shell.connection.reconnecting", message: "Reconnecting…" },
  // Mobile navigation drawer
  navLabel: { id: "app.shell.mobile.nav.label", message: "Navigation" },
  closeNav: { id: "app.shell.mobile.nav.close", message: "Close navigation" },
  home: { id: "app.shell.mobile.nav.home", message: "Home" },
  projects: { id: "app.shell.mobile.nav.projects", message: "Projects" },
  tools: { id: "app.shell.mobile.nav.tools", message: "Tools" },
  toolsTitle: { id: "app.shell.mobile.tools.title", message: "Tools" },
  toolsSection: { id: "app.shell.mobile.tools.section", message: "Tools" },
  newSession: { id: "app.shell.mobile.session.new", message: "New session" },
  noSessions: { id: "app.shell.mobile.session.empty", message: "No sessions yet" },
  agenda: { id: "app.shell.mobile.tool.agenda", message: "Agenda" },
  library: { id: "app.shell.mobile.tool.library", message: "Library" },
  performance: { id: "app.shell.mobile.tool.performance", message: "Performance" },
  plugins: { id: "app.shell.mobile.tool.plugins", message: "Plugins" },
  notes: { id: "app.shell.mobile.tool.notes", message: "Notes" },
  browser: { id: "app.shell.mobile.tool.browser", message: "Browser" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Notifications ────────────────────────────────────────────────────────────

export const notification = {
  responseReady: { id: "app.notification.response.ready", message: "Response ready" },
  sessionError: { id: "app.notification.session.error", message: "Session error" },
  errorFallback: { id: "app.notification.error.fallback", message: "An error occurred" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Sidebar ──────────────────────────────────────────────────────────────────

export const sidebar = {
  // Tooltips and aria-labels
  expand: { id: "app.sidebar.expand", message: "Expand sidebar" },
  collapse: { id: "app.sidebar.collapse", message: "Collapse sidebar" },
  search: { id: "app.sidebar.search", message: "Search sessions" },
  newSession: { id: "app.sidebar.newSession", message: "New session" },
  newSessionShort: { id: "app.sidebar.newSession.short", message: "New" },
  projects: { id: "app.sidebar.projects", message: "Projects" },
  addProject: { id: "app.sidebar.addProject", message: "Add project" },
  collapseAllProjects: { id: "app.sidebar.collapseAllProjects", message: "Collapse all projects" },
  agentMenu: { id: "app.sidebar.agent.menu", message: "Agent menu" },
  agent: { id: "app.sidebar.agent", message: "Agent" },
  // Sections
  recent: { id: "app.sidebar.section.recent", message: "Recent" },
  home: { id: "app.sidebar.section.home", message: "Home" },
  channel: { id: "app.sidebar.section.channel", message: "Channel" },
  background: { id: "app.sidebar.section.background", message: "Background" },
  github: { id: "app.sidebar.section.github", message: "GitHub" },
  // Empty states
  noRecentSessions: { id: "app.sidebar.empty.recent", message: "No recent sessions" },
  noSessions: { id: "app.sidebar.empty.sessions", message: "No sessions" },
  loadingProjects: { id: "app.sidebar.loading.projects", message: "Loading projects…" },
  loadMore: { id: "app.sidebar.loadMore", message: "Load more" },
  loadSessions: { id: "app.sidebar.loadSessions", message: "Load sessions" },
  // Project actions
  expandProject: { id: "app.sidebar.project.expand", message: "Expand project" },
  collapseProject: { id: "app.sidebar.project.collapse", message: "Collapse project" },
  pin: { id: "app.sidebar.project.pin", message: "Pin" },
  unpin: { id: "app.sidebar.project.unpin", message: "Unpin" },
  edit: { id: "app.sidebar.project.edit", message: "Edit" },
  archive: { id: "app.sidebar.project.archive", message: "Archive" },
  // Flyout
  projectsFlyout: { id: "app.sidebar.flyout.projects", message: "Projects" },
  // Agent hub
  noAgent: { id: "app.sidebar.agent.noAgent", message: "No agent" },
  createAgent: { id: "app.sidebar.agent.create", message: "Create Agent" },
  importAgent: { id: "app.sidebar.agent.import", message: "Import Agent" },
  settings: { id: "app.sidebar.menu.settings", message: "Settings" },
  providers: { id: "app.sidebar.menu.providers", message: "Providers" },
  repository: { id: "app.sidebar.menu.repository", message: "Repository" },
  account: { id: "app.sidebar.menu.account", message: "Account" },
  reconnect: { id: "app.sidebar.menu.reconnect", message: "Reconnect" },
  usage: { id: "app.sidebar.menu.usage", message: "Usage" },
  logout: { id: "app.sidebar.menu.logout", message: "Log out" },
  holosConnection: { id: "app.sidebar.holos.connection", message: "Holos Connection" },
  holosLogin: { id: "app.sidebar.holos.login", message: "Login" },
  holosService: { id: "app.sidebar.holos.service", message: "Service" },
  notLoggedIn: { id: "app.sidebar.holos.notLoggedIn", message: "Not logged in" },
  notAvailable: { id: "app.sidebar.holos.notAvailable", message: "Not available" },
  profileUnavailable: { id: "app.sidebar.holos.profileUnavailable", message: "Profile unavailable" },
  savedOnDevice: { id: "app.sidebar.holos.savedOnDevice", message: "Saved on this device" },
  // Connection status labels
  connected: { id: "app.sidebar.holos.connected", message: "Connected" },
  connecting: { id: "app.sidebar.holos.connecting", message: "Connecting…" },
  connectionFailed: { id: "app.sidebar.holos.connectionFailed", message: "Connection failed" },
  disconnected: { id: "app.sidebar.holos.disconnected", message: "Disconnected" },
  disabled: { id: "app.sidebar.holos.disabled", message: "Disabled" },
  signIn: { id: "app.sidebar.holos.signIn", message: "Sign in" },
  loadingIdentity: { id: "app.sidebar.holos.loadingIdentity", message: "Loading identity..." },
  localWorkspace: { id: "app.sidebar.holos.localWorkspace", message: "Local workspace" },
  connectedToHolos: { id: "app.sidebar.holos.connectedToHolos", message: "Connected to Holos" },
  // Attention notice
  busy: { id: "app.sidebar.attention.busy", message: "Working..." },
  // Orphan group
  orphanGroup: { id: "app.sidebar.channel.orphan", message: "Other" },
  // Session fallback
  untitled: { id: "app.sidebar.session.untitled", message: "Untitled" },
  // Brand / logo
  logoAlt: { id: "app.sidebar.brand.logo", message: "HOLOS" },
  channelFeishu: { id: "app.sidebar.channel.feishu", message: "Feishu" },
  addProjectDialogTitle: { id: "app.sidebar.dialog.addProject", message: "Add project" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Status Bar ───────────────────────────────────────────────────────────────

export const statusBar = {
  // Holos labels
  holosLoading: { id: "app.statusBar.holos.loading", message: "Holos loading" },
  holosSignedOut: { id: "app.statusBar.holos.signedOut", message: "Holos signed out" },
  holosConnected: { id: "app.statusBar.holos.connected", message: "Holos connected" },
  holosConnecting: { id: "app.statusBar.holos.connecting", message: "Holos connecting" },
  holosFailed: { id: "app.statusBar.holos.failed", message: "Holos failed" },
  holosDisconnected: { id: "app.statusBar.holos.disconnected", message: "Holos disconnected" },
  holosDisabled: { id: "app.statusBar.holos.disabled", message: "Holos disabled" },
  holosUnknown: { id: "app.statusBar.holos.unknown", message: "Holos unknown" },
  holosTitle: { id: "app.statusBar.holos.title", message: "Holos" },
  holosLoginLabel: { id: "app.statusBar.holos.login", message: "Login" },
  holosServiceLabel: { id: "app.statusBar.holos.service", message: "Service" },
  notLoggedIn: { id: "app.statusBar.holos.notLoggedIn", message: "Not logged in" },
  reconnect: { id: "app.statusBar.holos.reconnect", message: "Reconnect" },
  holosAgent: { id: "app.statusBar.holos.agent", message: "Agent {id}" },
  holosStateLoading: { id: "app.statusBar.holos.state.loading", message: "Loading" },
  holosStateSignedOut: { id: "app.statusBar.holos.state.signedOut", message: "Signed out" },
  holosStateConnected: { id: "app.statusBar.holos.state.connected", message: "Connected" },
  holosStateConnecting: { id: "app.statusBar.holos.state.connecting", message: "Connecting" },
  holosStateFailed: { id: "app.statusBar.holos.state.failed", message: "Failed" },
  holosStateDisconnected: { id: "app.statusBar.holos.state.disconnected", message: "Disconnected" },
  holosStateDisabled: { id: "app.statusBar.holos.state.disabled", message: "Disabled" },
  holosStateUnknown: { id: "app.statusBar.holos.state.unknown", message: "Unknown" },
  // Workspace
  mainCheckout: { id: "app.statusBar.workspace.main", message: "Main checkout" },
  worktreeLabel: { id: "app.statusBar.workspace.worktree", message: "Worktree: {name}" },
  branchLabel: { id: "app.statusBar.workspace.branch", message: "Branch: {name}" },
  gitWorktree: { id: "app.statusBar.workspace.gitWorktree", message: "Git worktree" },
  // Runtime
  runtimeLabel: { id: "app.statusBar.runtime.label", message: "Runtime: {label}" },
  copyRetryError: { id: "app.statusBar.runtime.copyRetryError", message: "Copy retry error" },
  copyRetryErrorFailed: {
    id: "app.statusBar.runtime.copyRetryErrorFailed",
    message: "Unable to copy the retry error.",
  },
  recoveringTooltip: {
    id: "app.statusBar.runtime.recovering",
    message: "Session is recovering from an incomplete turn",
  },
  contextOpenAria: {
    id: "app.statusBar.context.openAria",
    message: "Open Context, {tokens} input tokens, {usage}",
  },
  contextUsageKnown: { id: "app.statusBar.context.usageKnown", message: "{percent} used" },
  contextUsageUnavailable: { id: "app.statusBar.context.usageUnavailable", message: "usage unavailable" },
  contextInputTokens: { id: "app.statusBar.context.inputTokens", message: "input tokens" },
  contextLimitUnknown: { id: "app.statusBar.context.limitUnknown", message: "limit unknown" },
  contextClickHint: { id: "app.statusBar.context.clickHint", message: "click for Context" },
  // Subsessions
  subsessions: { id: "app.statusBar.subsessions", message: "Subsessions" },
  subsessionsCount: {
    id: "app.statusBar.subsessions.count",
    message: "{count, plural, one {# subsession} other {# subsessions}}",
  },
  loading: { id: "app.statusBar.subsessions.loading", message: "Loading" },
  total: { id: "app.statusBar.subsessions.total", message: "{total} total" },
  searchPlaceholder: { id: "app.statusBar.subsessions.search", message: "Search subsessions..." },
  loadingSubsessions: { id: "app.statusBar.subsessions.loadingList", message: "Loading subsessions" },
  loadError: { id: "app.statusBar.subsessions.loadError", message: "Couldn't load subsessions" },
  retry: { id: "app.statusBar.subsessions.retry", message: "Retry" },
  newSession: { id: "app.statusBar.subsessions.newSession", message: "New session" },
  noExchanges: { id: "app.statusBar.subsessions.noExchanges", message: "No exchanges yet" },
  noMatching: { id: "app.statusBar.subsessions.noMatching", message: "No matching subsessions" },
  noSubsessions: { id: "app.statusBar.subsessions.empty", message: "No subsessions yet" },
  previous: { id: "app.statusBar.subsessions.previous", message: "Previous" },
  next: { id: "app.statusBar.subsessions.next", message: "Next" },
  previousPage: { id: "app.statusBar.subsessions.previousPage", message: "Previous subsessions page" },
  nextPage: { id: "app.statusBar.subsessions.nextPage", message: "Next subsessions page" },
  range: { id: "app.statusBar.subsessions.range", message: "{start}–{end} of {total}" },
  emptyRange: { id: "app.statusBar.subsessions.emptyRange", message: "0 of 0" },
  // Subsessions status labels
  waiting: { id: "app.statusBar.subsessions.status.waiting", message: "waiting" },
  running: { id: "app.statusBar.subsessions.status.running", message: "running" },
  idle: { id: "app.statusBar.subsessions.status.idle", message: "idle" },
  // Panel
  permissionRequired: { id: "app.statusBar.panel.permissionRequired", message: "Permission required" },
  workspace: { id: "app.statusBar.panel.workspace", message: "Workspace" },
  runtime: { id: "app.statusBar.panel.runtime", message: "Runtime" },
  connections: { id: "app.statusBar.panel.connections", message: "Connections" },
  details: { id: "app.statusBar.details", message: "Details" },
  // Connection stats
  lspActive: { id: "app.statusBar.connections.lsp", message: "LSP · {connected} active" },
  mcpConnected: { id: "app.statusBar.connections.mcp", message: "MCP · {connected} connected" },
  mcpUnavailable: { id: "app.statusBar.connections.mcpUnavailable", message: ", {failed} unavailable" },
  cortexDone: { id: "app.statusBar.connections.cortexDone", message: "Cortex · {completed} done" },
  cortexRunning: { id: "app.statusBar.connections.cortexRunning", message: " · {running} running" },
  serverStatus: { id: "app.statusBar.connections.server", message: "Server · {name} ({status})" },
  serverActive: { id: "app.statusBar.connections.server.active", message: "active" },
  serverUnavailable: { id: "app.statusBar.connections.server.unavailable", message: "unavailable" },
  serverUnknown: { id: "app.statusBar.connections.server.unknown", message: "unknown" },
  contextUsage: {
    id: "app.statusBar.context.usage",
    message: "{tokens} {count, plural, one {token} other {tokens}} · {percentage} used",
  },
  // Runtime state labels
  runtimeWaiting: { id: "app.statusBar.runtime.waiting", message: "waiting" },
  runtimeIdle: { id: "app.statusBar.runtime.idle", message: "idle" },
  runtimeRunning: { id: "app.statusBar.runtime.running", message: "running" },
  runtimeRecovering: { id: "app.statusBar.runtime.recoveringState", message: "recovering" },
  retryAttempt: { id: "app.statusBar.runtime.retryAttempt", message: "retry {attempt}" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Top Bar ──────────────────────────────────────────────────────────────────

export const topBar = {
  sessionActions: { id: "app.topBar.session.actions", message: "Session actions" },
  rename: { id: "app.topBar.session.rename", message: "Rename" },
  exitWorktree: { id: "app.topBar.session.exitWorktree", message: "Exit worktree" },
  enterWorktree: { id: "app.topBar.session.enterWorktree", message: "Enter worktree" },
  exportSessionData: { id: "app.topBar.session.export", message: "Export session data" },
  importSessionData: { id: "app.topBar.session.import", message: "Import session data" },
  archive: { id: "app.topBar.session.archive", message: "Archive" },
  worktreeDisabledHint: {
    id: "app.topBar.session.worktreeDisabled",
    message: "Stop the session before changing worktree.",
  },
  modelLocked: {
    id: "app.topBar.model.locked",
    message: "Model is locked for this external agent after the session starts",
  },
  modelLockedLabel: { id: "app.topBar.model.lockedLabel", message: "Model locked" },
  selectModel: { id: "app.topBar.model.select", message: "Select model" },
  chooseModel: { id: "app.topBar.model.choose", message: "Choose model" },
  thinkingEffort: { id: "app.topBar.model.thinkingEffort", message: "Thinking effort" },
  defaultVariant: { id: "app.topBar.model.defaultVariant", message: "Default" },
  openNavigation: { id: "app.topBar.mobile.openNav", message: "Open navigation" },
  openTools: { id: "app.topBar.mobile.openTools", message: "Open tools" },
  newSession: { id: "app.topBar.session.new", message: "New session" },
  hideBottomSpace: { id: "app.topBar.bottomSpace.hide", message: "Hide BottomSpace" },
  openBottomSpace: { id: "app.topBar.bottomSpace.open", message: "Open BottomSpace" },
  hideSideWorkspace: { id: "app.topBar.sideWorkspace.hide", message: "Hide side workspace" },
  openSideWorkspace: { id: "app.topBar.sideWorkspace.open", message: "Open side workspace" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Dialogs ──────────────────────────────────────────────────────────────────

export const dialog = {
  // Confirm
  actionFailed: { id: "app.dialog.confirm.actionFailed", message: "Action failed" },
  actionNotCompleted: { id: "app.dialog.confirm.actionNotCompleted", message: "The action could not be completed." },
  cancel: { id: "app.dialog.confirm.cancel", message: "Cancel" },
  // Session rename
  renameSession: { id: "app.dialog.session.rename.title", message: "Rename session" },
  sessionTitle: { id: "app.dialog.session.rename.titleLabel", message: "Session title" },
  saving: { id: "app.dialog.session.rename.saving", message: "Saving..." },
  rename: { id: "app.dialog.session.rename.action", message: "Rename" },
  sessionRenamed: { id: "app.dialog.session.rename.toast.renamed", message: "Session renamed" },
  sessionRenameFailed: { id: "app.dialog.session.rename.toast.failed", message: "Rename failed" },
  sessionRenameRequestFailed: {
    id: "app.dialog.session.rename.toast.requestFailed",
    message: "Request failed",
  },
  // Session import
  importSessionData: { id: "app.dialog.session.import.title", message: "Import session data" },
  importIntoScope: { id: "app.dialog.session.import.intoScope", message: "Import into current scope" },
  importAcceptedFormats: {
    id: "app.dialog.session.import.acceptedFormats",
    message: "Accepts .json and .json.gz session exports",
  },
  exportFile: { id: "app.dialog.session.import.fileLabel", message: "Export file" },
  chooseFile: { id: "app.dialog.session.import.chooseFile", message: "Choose session export file" },
  importHint: {
    id: "app.dialog.session.import.hint",
    message: "Imported sessions get new IDs and use the current scope.",
  },
  importing: { id: "app.dialog.session.import.importing", message: "Importing..." },
  importAction: { id: "app.dialog.session.import.action", message: "Import session" },
  sessionImported: { id: "app.dialog.session.import.toast.imported", message: "Session imported" },
  sessionImportFailed: { id: "app.dialog.session.import.toast.failed", message: "Import failed" },
  importTargetAria: { id: "app.dialog.session.import.aria.importTarget", message: "Import target" },
  // Session export
  exportSessionData: { id: "app.dialog.session.export.title", message: "Export session data" },
  untitledSession: { id: "app.dialog.session.export.untitled", message: "Untitled session" },
  detailLevel: { id: "app.dialog.session.export.detailLevel", message: "Detail level" },
  exportHint: { id: "app.dialog.session.export.hint", message: "Save session data as .json.gz" },
  downloading: { id: "app.dialog.session.export.downloading", message: "Downloading..." },
  downloadExport: { id: "app.dialog.session.export.action", message: "Download export" },
  // Export modes
  compact: { id: "app.dialog.session.export.mode.compact", message: "Compact" },
  compactDesc: { id: "app.dialog.session.export.mode.compactDesc", message: "Truncated tool output, minimal thinking" },
  standard: { id: "app.dialog.session.export.mode.standard", message: "Standard" },
  standardDesc: {
    id: "app.dialog.session.export.mode.standardDesc",
    message: "Full messages, truncated large outputs",
  },
  full: { id: "app.dialog.session.export.mode.full", message: "Full" },
  fullDesc: { id: "app.dialog.session.export.mode.fullDesc", message: "Everything included, no truncation" },
  sessionExportDownloading: {
    id: "app.dialog.session.export.toast.downloading",
    message: "Session export downloading",
  },
  sessionExportFailed: { id: "app.dialog.session.export.toast.failed", message: "Export failed" },
  sessionSummaryAria: { id: "app.dialog.session.export.aria.summary", message: "Session summary" },
  // Model selection
  selectModel: { id: "app.dialog.model.title", message: "Select model" },
  selectModelDesc: {
    id: "app.dialog.model.description",
    message: "Choose a quick-switch model for the current session.",
  },
  modelSettings: { id: "app.dialog.model.settings", message: "Model settings" },
  connectProvider: { id: "app.dialog.model.connectProvider", message: "Connect provider" },
  searchModels: { id: "app.dialog.model.search", message: "Search models" },
  // Server selection
  servers: { id: "app.dialog.server.title", message: "Servers" },
  serversDesc: { id: "app.dialog.server.description", message: "Switch which Synergy server this app connects to." },
  searchServers: { id: "app.dialog.server.search", message: "Search servers" },
  noServers: { id: "app.dialog.server.empty", message: "No servers yet" },
  addServer: { id: "app.dialog.server.addSection", message: "Add a server" },
  serverUrl: { id: "app.dialog.server.urlLabel", message: "Server URL" },
  cannotConnect: { id: "app.dialog.server.cannotConnect", message: "Could not connect to server" },
  checking: { id: "app.dialog.server.checking", message: "Checking..." },
  add: { id: "app.dialog.server.add", message: "Add" },
  // MCP selection
  mcps: { id: "app.dialog.mcp.title", message: "MCPs" },
  mcpsDesc: { id: "app.dialog.mcp.description", message: "Connect or pause MCP servers for this session." },
  mcpConnectedCount: { id: "app.dialog.mcp.connectedCount", message: "{enabled} of {total} connected" },
  mcpConnected: { id: "app.dialog.mcp.stat.connected", message: "Connected" },
  mcpInactive: { id: "app.dialog.mcp.stat.inactive", message: "Inactive" },
  mcpNeedsAttention: { id: "app.dialog.mcp.stat.needsAttention", message: "Needs attention" },
  searchMcpServers: { id: "app.dialog.mcp.search", message: "Search servers" },
  clearMcpSearch: { id: "app.dialog.mcp.clearSearch", message: "Clear MCP search" },
  noMcpServers: { id: "app.dialog.mcp.empty.title", message: "No MCP servers configured" },
  noMcpMatches: { id: "app.dialog.mcp.empty.noMatches", message: "No matches" },
  noMcpServersDesc: {
    id: "app.dialog.mcp.empty.configDesc",
    message: "Configured MCP servers will appear here when this session can use them.",
  },
  noMcpMatchesDesc: { id: "app.dialog.mcp.empty.matchDesc", message: "Try a server name, status, or error detail." },
  mcpUpdating: { id: "app.dialog.mcp.status.updating", message: "Updating" },
  // MCP status labels
  mcpStatusConnected: { id: "app.dialog.mcp.status.connected", message: "Connected" },
  mcpStatusConnectedDesc: { id: "app.dialog.mcp.status.connectedDesc", message: "Available to agent tools" },
  mcpStatusStarting: { id: "app.dialog.mcp.status.starting", message: "Starting" },
  mcpStatusStartingDesc: { id: "app.dialog.mcp.status.startingDesc", message: "Starting the server process" },
  mcpStatusConnecting: { id: "app.dialog.mcp.status.connecting", message: "Connecting" },
  mcpStatusConnectingDesc: { id: "app.dialog.mcp.status.connectingDesc", message: "Opening the MCP connection" },
  mcpStatusLoadingTools: { id: "app.dialog.mcp.status.loadingTools", message: "Loading tools" },
  mcpStatusLoadingToolsDesc: {
    id: "app.dialog.mcp.status.loadingToolsDesc",
    message: "Reading tools, prompts, and resources",
  },
  mcpStatusReconnecting: { id: "app.dialog.mcp.status.reconnecting", message: "Reconnecting" },
  mcpStatusReconnectingDesc: {
    id: "app.dialog.mcp.status.reconnectingDesc",
    message: "Retry {attempt} of {maxAttempts}",
  },
  mcpStatusFailed: { id: "app.dialog.mcp.status.failed", message: "Failed" },
  mcpStatusFailedDesc: { id: "app.dialog.mcp.status.failedDesc", message: "Connection failed" },
  mcpStatusNeedsAuth: { id: "app.dialog.mcp.status.needsAuth", message: "Needs auth" },
  mcpStatusNeedsAuthDesc: { id: "app.dialog.mcp.status.needsAuthDesc", message: "Authentication is required" },
  mcpStatusRegistration: { id: "app.dialog.mcp.status.registration", message: "Registration" },
  mcpStatusRegistrationDesc: {
    id: "app.dialog.mcp.status.registrationDesc",
    message: "Client registration is required",
  },
  mcpStatusStopping: { id: "app.dialog.mcp.status.stopping", message: "Stopping" },
  mcpStatusStoppingDesc: { id: "app.dialog.mcp.status.stoppingDesc", message: "Disconnecting from the server" },
  mcpStatusDisabled: { id: "app.dialog.mcp.status.disabled", message: "Disabled" },
  mcpStatusDisabledDesc: { id: "app.dialog.mcp.status.disabledDesc", message: "Not connected for this session" },
  mcpStatusReady: { id: "app.dialog.mcp.status.ready", message: "Ready" },
  mcpStatusReadyDesc: { id: "app.dialog.mcp.status.readyDesc", message: "Ready to connect" },
  mcpConnectAria: { id: "app.dialog.mcp.connectAria", message: "Connect {name}" },
  mcpDisconnectAria: { id: "app.dialog.mcp.disconnectAria", message: "Disconnect {name}" },
  // Directory selection
  openProject: { id: "app.dialog.directory.title", message: "Open project" },
  openProjectDesc: { id: "app.dialog.directory.description", message: "Choose a folder to show in the sidebar." },
  projectFolder: { id: "app.dialog.directory.folderLabel", message: "Project folder" },
  searchFolders: { id: "app.dialog.directory.searchPlaceholder", message: "Search folders or paste a path" },
  search: { id: "app.dialog.directory.search", message: "Search" },
  clearSearch: { id: "app.dialog.directory.clearSearch", message: "Clear search" },
  searching: { id: "app.dialog.directory.searching", message: "Searching..." },
  noMatchingFolders: { id: "app.dialog.directory.empty", message: "No matching folders" },
  searchFailed: { id: "app.dialog.directory.error", message: "Search failed" },
  searchToChoose: { id: "app.dialog.directory.idle", message: "Search to choose a folder" },
  tryFullerPath: {
    id: "app.dialog.directory.emptyHint",
    message: "Try a fuller folder path or a different project name.",
  },
  checkPath: { id: "app.dialog.directory.errorHint", message: "Check the path and try again." },
  retry: { id: "app.dialog.directory.retry", message: "Retry" },
  selectFolderAria: { id: "app.dialog.directory.selectAria", message: "Select {path}" },
  serverFolders: { id: "app.dialog.directory.resultsLabel", message: "Server folders" },
  directoryPickerFailed: { id: "app.dialog.directory.toast.pickerFailed", message: "Folder picker failed" },
  directoryPickerCantOpen: {
    id: "app.dialog.directory.toast.pickerCantOpen",
    message: "Could not open the folder picker.",
  },
  browseFailed: { id: "app.dialog.directory.browseFailed", message: "Browse failed" },
  // File selection
  selectFile: { id: "app.dialog.file.title", message: "Select file" },
  searchFiles: { id: "app.dialog.file.search", message: "Search files" },
  noFilesFound: { id: "app.dialog.file.empty", message: "No files found" },
  // Scope edit
  editProject: { id: "app.dialog.scope.title", message: "Edit project" },
  projectName: { id: "app.dialog.scope.nameLabel", message: "Project name" },
  worktree: { id: "app.dialog.scope.worktree", message: "Worktree" },
  directory: { id: "app.dialog.scope.directory", message: "Directory" },
  scopeType: { id: "app.dialog.scope.type", message: "Type" },
  scopeID: { id: "app.dialog.scope.id", message: "ID" },
  projectDetails: { id: "app.dialog.scope.detailsLabel", message: "Project details" },
  save: { id: "app.dialog.scope.save", message: "Save" },
  scopeUpdated: { id: "app.dialog.scope.toast.updated", message: "Project updated" },
  scopeUpdateFailed: { id: "app.dialog.scope.toast.updateFailed", message: "Failed to update project" },
  scopeUpdateUnknownError: { id: "app.dialog.scope.toast.unknownError", message: "Unknown error" },
  // Browser model status copy
  directoryBrowserLoadingTitle: { id: "app.dialog.directory.browser.loading", message: "Searching folders" },
  directoryBrowserLoadingDesc: {
    id: "app.dialog.directory.browser.loadingDesc",
    message: "Checking nearby server directories first.",
  },
  directoryBrowserReadyTitle: {
    id: "app.dialog.directory.browser.ready",
    message: "{count, plural, one {# folder found} other {# folders found}}",
  },
  directoryBrowserReadyDesc: {
    id: "app.dialog.directory.browser.readyDesc",
    message: "Choose a folder to open it as a Synergy project.",
  },
  directoryBrowserEmptyTitle: { id: "app.dialog.directory.browser.empty", message: "No folders found" },
  directoryBrowserEmptyDesc: {
    id: "app.dialog.directory.browser.emptyDesc",
    message: "Try a more specific path, such as ~/projects, or search from a different parent folder.",
  },
  directoryBrowserErrorTitle: { id: "app.dialog.directory.browser.error", message: "Search failed" },
  directoryBrowserErrorDesc: {
    id: "app.dialog.directory.browser.errorDesc",
    message: "The server could not browse that folder. Check the path and try again.",
  },
  directoryBrowserIdleTitle: { id: "app.dialog.directory.browser.idle", message: "Search the server filesystem" },
  directoryBrowserIdleDesc: {
    id: "app.dialog.directory.browser.idleDesc",
    message:
      "Type a folder path or project name, then search. Use paths like ~/projects or C:\\Users\\you\\code to narrow the scan.",
  },
  // Export/Import plural
  exportSessionCount: {
    id: "app.dialog.session.export.summary.sessions",
    message: "{count, plural, one {# session} other {# sessions}}",
  },
  exportMessageCount: {
    id: "app.dialog.session.export.summary.messages",
    message: "{count, plural, one {# message} other {# messages}}",
  },
  exportSubsessionCount: {
    id: "app.dialog.session.export.summary.subsessions",
    message: "{count, plural, one {# subsession} other {# subsessions}}",
  },
  importSummary: {
    id: "app.dialog.session.import.summary",
    message:
      "{sessionCount, plural, one {# session} other {# sessions}}, {messageCount, plural, one {# message} other {# messages}}",
  },
  importWarningCount: {
    id: "app.dialog.session.import.warnings",
    message: "{count, plural, one {# warning} other {# warnings}}",
  },
  // MCP aria
  mcpConnectionSummaryAria: {
    id: "app.dialog.mcp.aria.connectionSummary",
    message: "MCP connection summary",
  },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Provider Connection Flow ─────────────────────────────────────────────────

export const providerFlow = {
  // Method descriptions
  methodApiDesc: { id: "app.provider.method.api.desc", message: "Paste a provider API key." },
  methodOauthDesc: { id: "app.provider.method.oauth.desc", message: "Authorize in the browser and return here." },
  methodImportDesc: {
    id: "app.provider.method.import.desc",
    message: "Use credentials already available on this device.",
  },
  methodApiDefaultLabel: { id: "app.provider.method.api.defaultLabel", message: "API key" },
  methodGenericDesc: { id: "app.provider.method.generic.desc", message: "Connect this provider." },
  // Choice screen
  accountRecovery: { id: "app.provider.choice.recovery", message: "Account recovery" },
  connectionMethod: { id: "app.provider.choice.method", message: "Connection method" },
  reconnectOrReplace: { id: "app.provider.choice.reconnectOrReplace", message: "Reconnect or replace credentials" },
  chooseHowToConnect: { id: "app.provider.choice.chooseHow", message: "Choose how to connect" },
  // States
  authInProgress: { id: "app.provider.state.pending", message: "Authorization in progress..." },
  authFailed: { id: "app.provider.state.failed", message: "Authorization failed: {error}" },
  tryAnotherMethod: { id: "app.provider.state.tryAnotherMethod", message: "Try another method" },
  // API key
  apiKey: { id: "app.provider.apiKey.title", message: "API key" },
  replaceKey: { id: "app.provider.apiKey.replace", message: "Replace a {provider} key" },
  addKey: { id: "app.provider.apiKey.add", message: "Add a {provider} key" },
  apiKeyDescription: {
    id: "app.provider.apiKey.description",
    message: "Use a key from your provider account to make this provider available in Synergy.",
  },
  apiKeyLabel: { id: "app.provider.apiKey.label", message: "{provider} API key" },
  apiKeyPlaceholder: { id: "app.provider.apiKey.placeholder", message: "API key" },
  back: { id: "app.provider.apiKey.back", message: "Back" },
  saveKey: { id: "app.provider.apiKey.save", message: "Save key" },
  apiKeyRequired: { id: "app.provider.apiKey.required", message: "API key is required" },
  // OAuth Step 1
  step1: { id: "app.provider.oauth.step1", message: "Step 1" },
  authorizeInBrowser: { id: "app.provider.oauth.authorizeInBrowser", message: "Authorize in your browser" },
  autoOpened: {
    id: "app.provider.oauth.autoOpened",
    message: "We opened the authorization page automatically. Use the button if it did not appear.",
  },
  openAuthPage: { id: "app.provider.oauth.openAuthPage", message: "Open authorization page" },
  // OAuth Step 2
  step2: { id: "app.provider.oauth.step2", message: "Step 2" },
  pasteAuthCode: { id: "app.provider.oauth.pasteAuthCode", message: "Paste the authorization code" },
  authCodeLabel: { id: "app.provider.oauth.authCodeLabel", message: "Authorization code" },
  authCodePlaceholder: { id: "app.provider.oauth.authCodePlaceholder", message: "Authorization code" },
  submit: { id: "app.provider.oauth.submit", message: "Submit" },
  invalidAuthCode: { id: "app.provider.oauth.invalidCode", message: "Invalid authorization code" },
  authCodeRequired: { id: "app.provider.oauth.codeRequired", message: "Authorization code is required" },
  // Device flow
  authorize: { id: "app.provider.device.authorize", message: "Authorize" },
  finishInBrowser: { id: "app.provider.device.finishInBrowser", message: "Finish in your browser" },
  deviceInstructions: {
    id: "app.provider.device.instructions",
    message: "Open the authorization page and enter this confirmation code when prompted.",
  },
  confirmationCode: { id: "app.provider.device.confirmationCode", message: "Confirmation code" },
  waitingForAuth: { id: "app.provider.device.waiting", message: "Waiting for authorization..." },
  authTimeout: {
    id: "app.provider.device.timeout",
    message: "Authorization timed out. Open the authorization page and enter the confirmation code, then try again.",
  },
  // Toast
  connected: { id: "app.provider.toast.connected", message: "connected" },
  reconnected: { id: "app.provider.toast.reconnected", message: "reconnected" },
  modelsAvailable: { id: "app.provider.toast.modelsAvailable", message: "{provider} models are now available to use." },
  // Back to providers
  backToProviders: { id: "app.provider.backToProviders", message: "Back to providers" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Library ───────────────────────────────────────────────────────────────────

export const library = {
  // Memory categories
  categoryUser: { id: "app.library.category.user", message: "User" },
  categorySelf: { id: "app.library.category.self", message: "Self" },
  categoryRelationship: { id: "app.library.category.relationship", message: "Relationship" },
  categoryInteraction: { id: "app.library.category.interaction", message: "Interaction" },
  categoryWorkflow: { id: "app.library.category.workflow", message: "Workflow" },
  categoryCoding: { id: "app.library.category.coding", message: "Coding" },
  categoryWriting: { id: "app.library.category.writing", message: "Writing" },
  categoryAsset: { id: "app.library.category.asset", message: "Asset" },
  categoryInsight: { id: "app.library.category.insight", message: "Insight" },
  categoryKnowledge: { id: "app.library.category.knowledge", message: "Knowledge" },
  categoryPersonal: { id: "app.library.category.personal", message: "Personal" },
  categoryGeneral: { id: "app.library.category.general", message: "General" },
  // Recall modes
  recallAlways: { id: "app.library.recall.always", message: "Always" },
  recallContextual: { id: "app.library.recall.contextual", message: "Contextual" },
  recallSearchOnly: { id: "app.library.recall.searchOnly", message: "Search only" },
  // Sort labels
  sortNewest: { id: "app.library.sort.newest", message: "Newest" },
  sortOldest: { id: "app.library.sort.oldest", message: "Oldest" },
  sortRelevance: { id: "app.library.sort.relevance", message: "Relevance" },
  sortReward: { id: "app.library.sort.reward", message: "Reward" },
  sortQValue: { id: "app.library.sort.qvalue", message: "Q-value" },
  sortMostVisited: { id: "app.library.sort.mostVisited", message: "Most visited" },
  // Reward dimensions (full labels)
  dimOutcome: { id: "app.library.dim.outcome", message: "Outcome" },
  dimIntent: { id: "app.library.dim.intent", message: "Intent" },
  dimExecution: { id: "app.library.dim.execution", message: "Execution" },
  dimOrchestration: { id: "app.library.dim.orchestration", message: "Orchestration" },
  dimExpression: { id: "app.library.dim.expression", message: "Expression" },
  // Empty / loading states
  loadError: { id: "app.library.experience.empty.loadError", message: "Failed to load experiences" },
  loadHint: {
    id: "app.library.experience.empty.loadHint",
    message: "Try refreshing the panel to load the latest experience records.",
  },
  noExperiences: { id: "app.library.experience.empty.none", message: "No experiences yet" },
  noExperiencesHint: {
    id: "app.library.experience.empty.noneHint",
    message: "Experiences are recorded as you work with the agent and capture behavioral patterns.",
  },
  // Actions
  retry: { id: "app.library.retry", message: "Retry" },
  // Document editor save status
  saved: { id: "app.library.editor.saved", message: "Saved" },
  // Experience stat badges
  rewardPrefix: { id: "app.library.experience.stat.reward", message: "R" },
  qValuePrefix: { id: "app.library.experience.stat.qValue", message: "Q" },
  confidencePrefix: { id: "app.library.experience.stat.confidence", message: "C" },
  scorePrefix: { id: "app.library.experience.stat.score", message: "S" },
  // Experience results count
  searchResults: {
    id: "app.library.experience.search.results",
    message: "{count} results",
  },
  totalExperiences: {
    id: "app.library.experience.total",
    message: "{total} experiences",
  },
  // Collapsible section
  sectionContent: { id: "app.library.experience.section.content", message: "Content" },
  // Reward radar
  sigmaPrefix: { id: "app.library.stats.reward.sigma", message: "σ" },
  // Skill import URL placeholder
  skillImportUrlPlaceholder: {
    id: "app.library.skills.import.urlPlaceholder",
    message: "https://example.com/skill.zip",
  },
} as const satisfies Record<string, AppMessageDescriptor>
// ── Plugin builtin navigation ─────────────────────────────────────────────────

export const pluginNav = {
  agenda: { id: "app.plugin.builtin.agenda", message: "Agenda" },
  library: { id: "app.plugin.builtin.library", message: "Library" },
  performance: { id: "app.plugin.builtin.performance", message: "Performance" },
  plugins: { id: "app.plugin.builtin.plugins", message: "Plugins" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Plugin marketplace ────────────────────────────────────────────────────────

export const pluginMarketplace = {
  navDiscover: { id: "app.plugin.marketplace.nav.discover", message: "Discover" },
  navInstalled: { id: "app.plugin.marketplace.nav.installed", message: "Installed" },
  navDevelopment: { id: "app.plugin.marketplace.nav.development", message: "Development" },
  installationDirectory: { id: "app.plugin.marketplace.installation.directory", message: "Local directory" },
  installationArchive: { id: "app.plugin.marketplace.installation.archive", message: "Local archive" },
  installationOfficialRegistry: {
    id: "app.plugin.marketplace.installation.officialRegistry",
    message: "Official registry",
  },
  installationLocalRegistry: {
    id: "app.plugin.marketplace.installation.localRegistry",
    message: "Local registry",
  },
  installationPackage: { id: "app.plugin.marketplace.installation.package", message: "{source} package" },
  installationBuiltIn: { id: "app.plugin.marketplace.installation.builtIn", message: "Built in" },
  versionLabel: { id: "app.plugin.marketplace.version.label", message: "v{version}" },
  apiVersionLabel: { id: "app.plugin.marketplace.apiVersion.label", message: "API {version}" },
  generationLabel: { id: "app.plugin.marketplace.generation.label", message: "Generation {id}" },
  headingLabel: { id: "app.plugin.marketplace.heading.label", message: "{label} plugins" },
  pluginApiLabel: { id: "app.plugin.marketplace.pluginApi.label", message: "Plugin API {version}" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Plugin permission groups ──────────────────────────────────────────────────

export const pluginPermission = {
  groupTools: { id: "app.plugin.permissionGroup.tools", message: "Tools" },
  groupData: { id: "app.plugin.permissionGroup.data", message: "Data" },
  groupNetwork: { id: "app.plugin.permissionGroup.network", message: "Network" },
  groupUi: { id: "app.plugin.permissionGroup.ui", message: "UI" },
  groupRuntime: { id: "app.plugin.permissionGroup.runtime", message: "Runtime" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Plugin risk labels ────────────────────────────────────────────────────────

export const pluginRisk = {
  low: { id: "app.plugin.risk.low", message: "Low" },
  medium: { id: "app.plugin.risk.medium", message: "Medium" },
  high: { id: "app.plugin.risk.high", message: "High" },
  ariaLow: { id: "app.plugin.risk.ariaLabel.low", message: "Risk level: Low" },
  ariaMedium: { id: "app.plugin.risk.ariaLabel.medium", message: "Risk level: Medium" },
  ariaHigh: { id: "app.plugin.risk.ariaLabel.high", message: "Risk level: High" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── Agent Visual ─────────────────────────────────────────────────────────────

export const agentVisual = {
  externalBadge: { id: "app.agent.visual.externalBadge", message: "External" },
  defaultLabel: { id: "app.agent.visual.defaultLabel", message: "Agent" },
  // ── Agent role labels (3+ segment IDs) ─────────────────────────────
  roleSynergy: { id: "app.agent.role.synergy", message: "Synergy" },
  roleSynergyMax: { id: "app.agent.role.synergyMax", message: "Synergy Max" },
  roleDeveloper: { id: "app.agent.role.developer", message: "Developer" },
  roleExplore: { id: "app.agent.role.explore", message: "Explore" },
  roleScout: { id: "app.agent.role.scout", message: "Scout" },
  roleAdvisor: { id: "app.agent.role.advisor", message: "Advisor" },
  roleInspector: { id: "app.agent.role.inspector", message: "Inspector" },
  roleScribe: { id: "app.agent.role.scribe", message: "Scribe" },
  roleScholar: { id: "app.agent.role.scholar", message: "Scholar" },
  roleRequirements: { id: "app.agent.role.requirementsEngineer", message: "Requirements" },
  roleCodeMap: { id: "app.agent.role.codeCartographer", message: "Code Map" },
  roleDependencyTrace: { id: "app.agent.role.dependencyTracer", message: "Dependency Trace" },
  roleSolutionArchitect: { id: "app.agent.role.solutionArchitect", message: "Solution Architect" },
  roleApiContract: { id: "app.agent.role.apiContractDesigner", message: "API Contract" },
  roleMigration: { id: "app.agent.role.migrationArchitect", message: "Migration" },
  roleTestStrategy: { id: "app.agent.role.testStrategist", message: "Test Strategy" },
  roleFixtures: { id: "app.agent.role.fixtureBuilder", message: "Fixtures" },
  rolePropertyTests: { id: "app.agent.role.propertyTestEngineer", message: "Property Tests" },
  roleTypeTests: { id: "app.agent.role.typeTestEngineer", message: "Type Tests" },
  roleImplementation: { id: "app.agent.role.implementationEngineer", message: "Implementation" },
  roleRefactor: { id: "app.agent.role.refactoringEngineer", message: "Refactor" },
  roleIntegration: { id: "app.agent.role.integrationEngineer", message: "Integration" },
  roleDocs: { id: "app.agent.role.documentationEngineer", message: "Docs" },
  roleQualityGate: { id: "app.agent.role.qualityGatekeeper", message: "Quality Gate" },
  rolePythonQuality: { id: "app.agent.role.pythonQualityEngineer", message: "Python Quality" },
  roleRustQuality: { id: "app.agent.role.rustQualityEngineer", message: "Rust Quality" },
  roleTsQuality: { id: "app.agent.role.typescriptQualityEngineer", message: "TS Quality" },
  roleMaintainability: { id: "app.agent.role.maintainabilityReviewer", message: "Maintainability" },
  roleSecurity: { id: "app.agent.role.securityReviewer", message: "Security" },
  rolePerformance: { id: "app.agent.role.performanceReviewer", message: "Performance" },
  roleApiCompatibility: { id: "app.agent.role.apiCompatibilityReviewer", message: "API Compatibility" },
  roleDocReview: { id: "app.agent.role.documentationReviewer", message: "Doc Review" },
  roleDocsResearch: { id: "app.agent.role.docsResearcher", message: "Docs Research" },
  roleResearchMethod: { id: "app.agent.role.researchMethodologist", message: "Research Method" },
  roleResearchScout: { id: "app.agent.role.researchScout", message: "Research Scout" },
  roleLiteratureSearch: { id: "app.agent.role.literatureSearcher", message: "Literature Search" },
  roleLiteratureAnalyst: { id: "app.agent.role.literatureAnalyst", message: "Literature Analyst" },
  roleMemory: { id: "app.agent.role.memoryCurator", message: "Memory" },
  roleNotes: { id: "app.agent.role.noteLibrarian", message: "Notes" },
  roleSessionHistory: { id: "app.agent.role.sessionHistorian", message: "Session History" },
  roleSupervisor: { id: "app.agent.role.supervisor", message: "Supervisor" },
  roleCodex: { id: "app.agent.role.codex", message: "Codex" },
  roleClaudeCode: { id: "app.agent.role.claudeCode", message: "Claude Code" },
  roleOpenClaw: { id: "app.agent.role.openClaw", message: "OpenClaw" },
} as const satisfies Record<string, AppMessageDescriptor>

// ── All descriptors (for convenience / barrel re-exports) ─────────────────────

export const messages = {
  workspace,
  panels,
  contextWorkspace,
  rawMessages,
  browser,
  consolePanel,
  networkPanel,
  elementsPanel,
  downloadsPanel,
  assetsPanel,
  fileWorkbench,
  fileExplorer,
  terminal,
  sessionReview,
  note,
  bubbleMenu,
  slashMenu,
  docEditor,
  library,
  appShell,
  notification,
  sidebar,
  statusBar,
  topBar,
  dialog,
  providerFlow,
  agentVisual,
  pluginNav,
  pluginMarketplace,
  pluginPermission,
  pluginRisk,
} as const
