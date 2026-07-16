/**
 * Explicit Lingui runtime message descriptors.
 *
 * Each descriptor provides an `id` (stable extraction key) and the English
 * `message` (source text / fallback).  Components use `<Trans>` with string
 * literals for JSX content and `useLingui()._` for imperative strings.
 */

export interface AppMessageDescriptor {
  /** Stable extraction key (dot-separated, lowercase, app.* namespace). */
  id: string
  /** English source text (fallback when no catalog is loaded). */
  message: string
}

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
  review: { id: "app.panel.review", message: "Review" },
  files: { id: "app.panel.files", message: "Files" },
  openFile: { id: "app.panel.files.openFile", message: "Open file" },
  browser: { id: "app.panel.browser", message: "Browser" },
  terminal: { id: "app.panel.terminal", message: "Terminal" },
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
  addTag: { id: "app.note.detail.addTag", message: "Add tag" },
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

export const messages = {
  workspace,
  panels,
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
} as const
