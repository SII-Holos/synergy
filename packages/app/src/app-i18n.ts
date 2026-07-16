/** Runtime Lingui descriptors for app shell, entry, commands, and pages.
 *  Translate at use time via `useLocale().i18n._(descriptor)`. */

export const AP = {
  // ── app.tsx ─────────────────────────────────────────────────────────
  appLoading: { id: "app.shell.loading", message: "Loading…" },
  appModelNotConfigured: {
    id: "app.shell.modelNotConfigured",
    message: "AI model not configured — run {cmd} in your terminal to set one up",
  },
  appModelConfigCmd: { id: "app.shell.modelConfigCmd", message: "synergy config" },

  // ── entry.tsx ───────────────────────────────────────────────────────
  entryCopyFailed: { id: "app.entry.copyFailed", message: "Copy failed" },
  entryCopyFailedDetail: {
    id: "app.entry.copyFailedDetail",
    message: "Unable to copy to the clipboard.",
  },
  entryRootMissing: {
    id: "app.entry.rootMissing",
    message:
      "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  },

  // ── context/command.tsx ─────────────────────────────────────────────
  commandTitle: { id: "app.command.title", message: "Commands" },
  commandSearchPlaceholder: {
    id: "app.command.searchPlaceholder",
    message: "Search commands",
  },
  commandEmpty: { id: "app.command.empty", message: "No commands found" },
  commandCategorySuggested: { id: "app.command.category.suggested", message: "Suggested" },

  // ── pages/error.tsx ─────────────────────────────────────────────────
  errorTitle: { id: "app.error.title", message: "Something went wrong" },
  errorSubtitle: {
    id: "app.error.subtitle",
    message: "An error occurred while loading the application.",
  },
  errorDetailsLabel: { id: "app.error.detailsLabel", message: "Error Details" },
  errorRestart: { id: "app.error.restart", message: "Restart" },
  errorReport: {
    id: "app.error.report",
    message: "Report this issue on GitHub",
  },
  errorVersionLabel: { id: "app.error.versionLabel", message: "Version: {version}" },
  errorMCPFailed: {
    id: "app.error.mcpFailed",
    message: 'MCP server "{name}" failed. Note, synergy does not support MCP authentication yet.',
  },
  errorProviderAuth: {
    id: "app.error.providerAuth",
    message: "Provider authentication failed ({providerID}): {message}",
  },
  errorModelNotFound: {
    id: "app.error.modelNotFound",
    message: "Model not found: {providerID}/{modelID}",
  },
  errorModelNotFoundSuggest: {
    id: "app.error.modelNotFoundSuggest",
    message: "Did you mean: {suggestions}",
  },
  errorModelCheckConfig: {
    id: "app.error.modelCheckConfig",
    message: "Check your config (synergy.json) provider/model names",
  },
  errorProviderInit: {
    id: "app.error.providerInit",
    message: 'Failed to initialize provider "{providerID}". Check credentials and configuration.',
  },
  errorConfigInvalid: {
    id: "app.error.configInvalid",
    message: "Config file at {path} is invalid",
  },
  errorConfigNotJson: {
    id: "app.error.configNotJson",
    message: "Config file at {path} is not valid JSON(C)",
  },
  errorConfigDirectoryTypo: {
    id: "app.error.configDirectoryTypo",
    message:
      'Directory "{dir}" in {path} is not valid. Rename the directory to "{suggestion}" or remove it. This is a common typo.',
  },
  errorConfigFrontmatter: {
    id: "app.error.configFrontmatter",
    message: "Failed to parse frontmatter in {path}: {message}",
  },
  errorUnknownError: { id: "app.error.unknownError", message: "Unknown error" },
  errorStatus: { id: "app.error.status", message: "Status: {code}" },
  errorRetryable: { id: "app.error.retryable", message: "Retryable: {value}" },
  errorResponseBody: { id: "app.error.responseBody", message: "Response body:" },

  // ── pages/server-connection-error.tsx ───────────────────────────────
  serverErrorTitle: { id: "app.serverError.title", message: "Can’t reach the server" },
  serverErrorDesc: {
    id: "app.serverError.desc",
    message: "Synergy can’t connect to the backend right now. Retry the connection or switch to a different server.",
  },
  serverErrorUrlLabel: { id: "app.serverError.urlLabel", message: "Server URL" },
  serverErrorLocalHint: {
    id: "app.serverError.localHint",
    message: "If you’re running locally, make sure the server is started before retrying.",
  },
  serverErrorRemoteHint: {
    id: "app.serverError.remoteHint",
    message: "Verify the server URL and confirm the backend is online before retrying.",
  },
  serverErrorRetry: { id: "app.serverError.retry", message: "Retry" },
  serverErrorRetrying: { id: "app.serverError.retrying", message: "Retrying…" },
  serverErrorChangeServer: { id: "app.serverError.changeServer", message: "Change server" },

  // ── pages/layout.tsx ────────────────────────────────────────────────
  layoutColorScheme: { id: "app.layout.colorScheme", message: "Color scheme" },
  layoutSystem: { id: "app.layout.colorScheme.system", message: "System" },
  layoutLight: { id: "app.layout.colorScheme.light", message: "Light" },
  layoutDark: { id: "app.layout.colorScheme.dark", message: "Dark" },
  layoutPermissionTitle: { id: "app.layout.permission.title", message: "Permission required" },
  layoutPermissionDesc: {
    id: "app.layout.permission.desc",
    message: "{sessionTitle} in {projectName} needs permission",
  },
  layoutPermissionGoTo: { id: "app.layout.permission.goTo", message: "Go to session" },
  layoutPermissionDismiss: { id: "app.layout.permission.dismiss", message: "Dismiss" },
  layoutNewSession: { id: "app.layout.session.new", message: "New session" },
  layoutOpenProject: { id: "app.layout.project.open", message: "Open project" },
  layoutOpenProjectDialogTitle: { id: "app.layout.project.dialogTitle", message: "Open project" },
  layoutConnectProvider: { id: "app.layout.provider.connect", message: "Connect provider" },
  layoutSwitchServer: { id: "app.layout.server.switch", message: "Switch server" },
  layoutPreviousSession: { id: "app.layout.session.previous", message: "Previous session" },
  layoutNextSession: { id: "app.layout.session.next", message: "Next session" },
  layoutArchiveSession: { id: "app.layout.session.archive", message: "Archive session" },
  layoutCycleColorScheme: { id: "app.layout.theme.cycleColorScheme", message: "Cycle color scheme" },
  layoutHelp: { id: "app.layout.help", message: "Help" },
  layoutShowCommands: { id: "app.layout.help.showCommands", message: "Show all available commands" },
  layoutSearchSessions: { id: "app.layout.session.search", message: "Search sessions" },
  layoutSearchSessionsDesc: {
    id: "app.layout.session.searchDesc",
    message: "Search sessions across all projects",
  },
  layoutColorSchemeUse: { id: "app.layout.colorScheme.use", message: "Use color scheme: {scheme}" },
  layoutLeftWorktree: { id: "app.layout.worktree.left", message: "Left worktree" },
  layoutMovedToWorktree: { id: "app.layout.worktree.moved", message: "Moved to worktree" },
  layoutWorktreeDesc: {
    id: "app.layout.worktree.desc",
    message: "This session now runs in {name}.",
  },
  layoutWorktreeDescDefault: {
    id: "app.layout.worktree.descDefault",
    message: "This session now runs in the new worktree.",
  },
  layoutWorktreeLeftToast: {
    id: "app.layout.worktree.leftToast",
    message: "Session returned to the main checkout.",
  },
  layoutLeaveWorktreeFailed: {
    id: "app.layout.worktree.leaveFailed",
    message: "Leave worktree failed",
  },
  layoutMoveWorktreeFailed: {
    id: "app.layout.worktree.moveFailed",
    message: "Move to worktree failed",
  },

  // ── pages/session.tsx ───────────────────────────────────────────────
  sessionErrorTitle: { id: "app.session.error.title", message: "Couldn’t load conversation" },
  sessionLoading: { id: "app.session.loading", message: "Loading conversation…" },
  sessionRetry: { id: "app.session.retry", message: "Retry" },
  sessionNoMessages: { id: "app.session.noMessages", message: "No messages yet" },
  sessionRefreshing: { id: "app.session.refreshing", message: "Refreshing…" },
  sessionRefresh: { id: "app.session.refresh", message: "Refresh" },
  sessionLoadingChanges: { id: "app.session.loadingChanges", message: "Loading changes…" },
  sessionFilesChanged: { id: "app.session.filesChanged", message: "{count} Files Changed" },
  sessionCloseReview: { id: "app.session.closeReview", message: "Close review" },
  sessionTitleHome: { id: "app.session.title.home", message: "Home" },
  sessionTitleNew: { id: "app.session.title.new", message: "New session" },
  sessionTitleApp: { id: "app.session.title.app", message: "Synergy" },
  sessionTitleTemplate: { id: "app.session.title.template", message: "{title} — Synergy" },
  sessionPartFile: { id: "app.session.part.file", message: "[file:{filename}]" },
  sessionPartNote: { id: "app.session.part.note", message: "[note:{title}]" },
  sessionPartSession: { id: "app.session.part.session", message: "[session:{title}]" },

  // ── pages/home.tsx ──────────────────────────────────────────────────

  // ── components/agent-visual.tsx ─────────────────────────────────────
  agentVisualExternal: { id: "app.agentVisual.external", message: "External" },

  // ── components/scopes/active-zone.tsx ────────────────────────────────
  scopesActiveZoneActive: { id: "app.scopes.activeZone.active", message: "Active" },
  scopesActiveZoneWorking: { id: "app.scopes.activeZone.working", message: "Working\u2026" },
  scopesActiveZoneRetrying: { id: "app.scopes.activeZone.retrying", message: "Retrying\u2026" },
  scopesActiveZonePermission: { id: "app.scopes.activeZone.permissionRequest", message: "Permission request" },
  scopesActiveZoneError: { id: "app.scopes.activeZone.error", message: "Error" },
  scopesActiveZoneNewActivity: { id: "app.scopes.activeZone.newActivity", message: "New activity" },
  scopesActiveZoneTasks: {
    id: "app.scopes.activeZone.tasks",
    message: "{count, plural, one {# task} other {# tasks}}",
  },
  scopesActiveZoneTasksRunning: {
    id: "app.scopes.activeZone.tasksRunning",
    message: "{running}/{count} tasks running",
  },

  // ── components/scopes/session-row.tsx ────────────────────────────────
  scopesSessionNewSession: { id: "app.scopes.session.newSession", message: "New session" },
  scopesSessionUntitled: { id: "app.scopes.session.untitled", message: "Untitled" },
  scopesSessionPin: { id: "app.scopes.session.pin", message: "Pin" },
  scopesSessionUnpin: { id: "app.scopes.session.unpin", message: "Unpin" },
  scopesSessionRename: { id: "app.scopes.session.rename", message: "Rename" },
  scopesSessionArchive: { id: "app.scopes.session.archive", message: "Archive" },
  scopesSessionSubsessionCount: {
    id: "app.scopes.session.subsessionCount",
    message: "{count, plural, one {# subsession} other {# subsessions}}",
  },

  // ── components/scopes/pagination-bar.tsx ─────────────────────────────
  scopesPaginationSessions: {
    id: "app.scopes.pagination.sessions",
    message: "{count, plural, one {# session} other {# sessions}}",
  },
  homeStart: { id: "app.home.start", message: "Start" },
}
