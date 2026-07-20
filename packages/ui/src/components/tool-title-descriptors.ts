import type { MessageDescriptor } from "@lingui/core"

function d(id: string, message: string): MessageDescriptor {
  return { id: id, message: message }
}

// ── Tool trigger titles ────────────────────────────────────────────
export const TOOL_TITLE_DESC: Record<string, MessageDescriptor> = {
  // File ops
  read: d("tool.title.read", "Read file"),
  view_file: d("tool.title.view-file", "View File"),
  view_image: d("tool.title.view-image", "View Image"),
  list: d("tool.title.list", "List directory"),
  glob: d("tool.title.glob", "Match files with Glob"),
  grep: d("tool.title.grep", "Search with Grep"),
  file_search: d("tool.title.file-search", "Search files"),
  scan_files: d("tool.title.scan-files", "Scan Files"),
  parse_code: d("tool.title.parse-code", "Parse Code"),
  ast_grep: d("tool.title.ast-search", "Search AST"),
  edit: d("tool.title.edit", "Edit file"),
  revise_file: d("tool.title.revise-file", "Revise File"),
  write: d("tool.title.write", "Write file"),
  save_file: d("tool.title.save-file", "Save File"),
  create_file: d("tool.title.create-file", "Create File"),
  multiedit: d("tool.title.multi-edit", "Edit file in multiple places"),
  patch: d("tool.title.patch", "Apply patch"),
  look_at: d("tool.title.look-at", "Analyze file"),
  scan_document: d("tool.title.read-document", "Read Document"),

  // Shell
  bash: d("tool.title.shell", "Execute command"),
  process: d("tool.title.process", "Manage process"),

  // Search / web
  webfetch: d("tool.title.webfetch", "Read web page"),
  websearch: d("tool.title.web-search", "Search web"),
  arxiv_search: d("tool.title.arxiv-search", "Search arXiv"),
  arxiv_download: d("tool.title.arxiv-download", "Download arXiv paper"),
  context7_resolve_library: d("tool.title.resolve-library", "Resolve Library"),
  context7_query_docs: d("tool.title.query-docs", "Query Docs"),

  // DAG / task orchestration
  task: d("tool.title.task", "Call subagent"),
  task_list: d("tool.title.task-list", "View tasks"),
  task_output: d("tool.title.task-output", "View task result"),
  task_cancel: d("tool.title.task-cancel", "Cancel task"),
  todowrite: d("tool.title.to-dos", "Update to-dos"),
  todoread: d("tool.title.read-to-dos", "Read to-dos"),
  dagwrite: d("tool.title.dag", "Update DAG"),
  dagread: d("tool.title.read-dag", "Read DAG"),
  dagpatch: d("tool.title.dag-patch", "Update DAG"),
  question: d("tool.title.questions", "Ask questions"),
  question_timed_out: d("tool.title.question-timed-out", "Question Timed Out"),
  question_no_response: d("tool.title.question-no-response", "No response received"),
  loop_stop: d("tool.title.request-review", "Request Review"),
  light_loop_approve: d("tool.title.approve-light-loop", "Approve Light Loop"),
  light_loop_reject: d("tool.title.reject-light-loop", "Reject Light Loop"),
  blueprint_loop_stop: d("tool.title.request-blueprint-review", "Request Blueprint Review"),
  blueprint_loop_approve: d("tool.title.approve-blueprint-loop", "Approve BlueprintLoop"),
  blueprint_loop_reject: d("tool.title.reject-blueprint-loop", "Reject BlueprintLoop"),
  batch: d("tool.title.batch", "Run batch"),

  // Sessions
  session_list: d("tool.title.sessions", "View sessions"),
  scope_list: d("tool.title.scopes", "View Scopes"),
  session_read: d("tool.title.read-session", "Read Session"),
  session_search: d("tool.title.search-sessions", "Search Sessions"),
  session_send: d("tool.title.send-message", "Send Message"),
  session_control: d("tool.title.control-session", "Manage session"),
  session_status: d("tool.title.session-status", "View session status"),
  session_compact: d("tool.title.compact-session", "Compact Session"),
  session_abort: d("tool.title.abort-session", "Abort Session"),
  session_answer_question: d("tool.title.answer-question", "Answer Question"),
  session_dismiss_question: d("tool.title.dismiss-question", "Dismiss Question"),
  session_approve_permission: d("tool.title.approve-permission", "Allow operation"),
  session_deny_permission: d("tool.title.deny-permission", "Deny operation"),

  // Knowledge / memory / notes
  memory_search: d("tool.title.memory-search", "Search memories"),
  memory_get: d("tool.title.memory-get", "Read memory"),
  memory_write: d("tool.title.memory-write", "Write memory"),
  memory_edit: d("tool.title.memory-edit", "Edit memory"),
  note_list: d("tool.title.notes", "View notes"),
  note_read: d("tool.title.read-note", "Read Note"),
  note_write: d("tool.title.write-note", "Write Note"),
  note_edit: d("tool.title.edit-note", "Edit Note"),
  note_search: d("tool.title.note-search", "Search notes"),
  note_archive: d("tool.title.archive-note", "Archive Note"),
  note_unarchive: d("tool.title.unarchive-note", "Unarchive Note"),
  note_delete: d("tool.title.delete-note", "Delete Note"),
  blueprints: d("tool.title.blueprints", "View Blueprints"),
  read_blueprint: d("tool.title.read-blueprint", "Read Blueprint"),
  write_blueprint: d("tool.title.write-blueprint", "Write Blueprint"),
  edit_blueprint: d("tool.title.edit-blueprint", "Edit Blueprint"),
  blueprint_search: d("tool.title.blueprint-search", "Search Blueprints"),

  // Agenda
  agenda_schedule: d("tool.title.schedule-agenda", "Schedule Agenda"),
  agenda_watch: d("tool.title.watch", "Monitor schedule"),
  agenda_list: d("tool.title.agenda", "View schedule"),
  agenda_update: d("tool.title.update-agenda", "Update Agenda"),
  agenda_cancel: d("tool.title.cancel-agenda", "Cancel Agenda"),
  agenda_trigger: d("tool.title.trigger-agenda", "Run schedule now"),
  agenda_logs: d("tool.title.agenda-logs", "View schedule history"),

  // Profile
  profile_get: d("tool.title.profile", "View profile"),
  profile_update: d("tool.title.update-profile", "Update Profile"),

  // Communication
  email_send: d("tool.title.send-email", "Send Email"),
  email_read: d("tool.title.read-email", "Read Email"),
  email_search: d("tool.title.search-email", "Search Email"),
  email_mark_read: d("tool.title.mark-read", "Mark Read"),
  email_inbox: d("tool.title.email-inbox", "View inbox"),
  generate_image: d("tool.title.generate-image", "Generate Image"),
  edit_image: d("tool.title.edit-image", "Edit Image"),
  attach: d("tool.title.attach", "Add attachment"),

  // Platform
  runtime_reload: d("tool.title.runtime-reload", "Reload runtime"),
  skill: d("tool.title.skill", "Use skill"),
  search_tools: d("tool.title.search-tools", "Search Tools"),
  expand_tools: d("tool.title.expand-tools", "Load tools"),
  lsp: d("tool.title.lsp", "Query code intelligence"),
  connect: d("tool.title.connect", "Connect"),
  connect_opening: d("tool.title.connect-opening", "Opening"),
  connect_closing: d("tool.title.connect-closing", "Closing"),
  connect_status: d("tool.title.connect-status", "View connection status"),
  connect_list: d("tool.title.connect-list", "View connections"),
  connect_connected: d("tool.title.connected", "Connected"),
  connect_disconnected: d("tool.title.disconnected", "Disconnected"),
  worktree_enter: d("tool.title.enter-worktree", "Enter isolated workspace"),
  worktree_leave: d("tool.title.leave-worktree", "Leave isolated workspace"),
  worktree_list: d("tool.title.worktrees", "View isolated workspaces"),

  // Render / diagram
  render: d("tool.title.render", "Render content"),
  diagram: d("tool.title.diagram", "Generate diagram"),

  // Research
  research_init: d("tool.title.research-init", "Start research"),
  research_state: d("tool.title.research-state", "Manage research state"),
  research_idea: d("tool.title.idea", "Manage research ideas"),
  research_plan: d("tool.title.plan", "Manage research plan"),
  research_experiment: d("tool.title.experiment", "Manage experiments"),
  research_claim: d("tool.title.claim", "Manage research claims"),
  research_exhibit: d("tool.title.exhibit", "Manage research exhibits"),
  research_paper: d("tool.title.paper", "Manage research paper"),
  research_submission: d("tool.title.submission", "Manage research submission"),
  research_wiki: d("tool.title.wiki", "Manage research knowledge"),
  research_timeline: d("tool.title.timeline", "Manage research timeline"),

  // Browser
  browser_navigation: d("browser.title.navigation", "Navigate web"),
  browser_snapshot: d("browser.title.snapshot", "Capture page snapshot"),
  browser_action: d("browser.title.action", "Operate page"),
  browser_wait: d("browser.title.wait", "Wait for page"),
  browser_read: d("browser.title.read", "Read page"),
  browser_inspect: d("browser.title.inspect", "Inspect page"),
  browser_screenshot: d("browser.title.screenshot", "Capture screenshot"),
  browser_eval: d("browser.title.evaluate", "Evaluate page script"),
  browser_console: d("browser.title.console", "Inspect console"),
  browser_network: d("browser.title.network", "Inspect network requests"),
  browser_performance: d("browser.title.performance", "Analyze page performance"),
  browser_audit: d("browser.title.audit", "Audit page"),
  browser_emulate: d("browser.title.emulate", "Emulate device"),
  browser_dialog: d("browser.title.dialog", "Handle page dialog"),
  browser_upload: d("browser.title.upload", "Upload file"),
  browser_downloads: d("browser.title.downloads", "Inspect downloads"),
  browser_clipboard: d("browser.title.clipboard", "Read or write clipboard"),
  browser_assets: d("browser.title.assets", "Inspect page assets"),
  browser_annotate: d("browser.title.annotate", "Annotate page"),
  browser_view: d("browser.title.browser-view", "View browser"),

  // Legacy qzcli — TODO remove
  qz_login: d("tool.title.qz-login", "Log in to QZ"),
  qz_set_cookie: d("tool.title.set-cookie", "Set Cookie"),
  qz_workspaces: d("tool.title.workspaces", "View workspaces"),
  qz_refresh_resources: d("tool.title.refresh-resources", "Refresh Resources"),
  qz_availability: d("tool.title.availability", "Check availability"),
  qz_jobs: d("tool.title.jobs", "View jobs"),
  qz_job_detail: d("tool.title.job-detail", "View job details"),
  qz_stop_job: d("tool.title.stop-job", "Stop Job"),
  qz_gpu_usage: d("tool.title.gpu-usage", "View GPU usage"),
  qz_status_catalog: d("tool.title.status-catalog", "View status catalog"),
  qz_track_job: d("tool.title.track-job", "Track Job"),
  qz_tracked_jobs: d("tool.title.tracked-jobs", "View tracked jobs"),
  qz_submit_job: d("tool.title.submit-job", "Submit Job"),
  qz_submit_hpc: d("tool.title.submit-hpc-job", "Submit HPC Job"),
  qz_hpc_usage: d("tool.title.hpc-usage", "View HPC usage"),

  // Inspire — base keys use the most common variant; getToolInfo selects its own
  inspire_status: d("tool.title.platform-status", "View platform status"),
  inspire_config: d("tool.title.set-default", "Set Default"),
  inspire_login: d("tool.title.sii-login", "Log in to SII"),
  inspire_images: d("tool.title.search-images", "Search Images"),
  inspire_image_push: d("tool.title.push-image", "Push Image"),
  inspire_submit: d("tool.title.submit-gpu-job", "Submit GPU Job"),
  inspire_submit_hpc: d("tool.title.submit-hpc-job", "Submit HPC Job"),
  inspire_stop: d("tool.title.stop-job", "Stop Job"),
  inspire_jobs: d("tool.title.jobs", "View jobs"),
  inspire_job_detail: d("tool.title.job-detail", "View job details"),
  inspire_logs: d("tool.title.job-logs", "View job logs"),
  inspire_metrics: d("tool.title.job-metrics", "View job metrics"),
  inspire_inference: d("tool.title.inference-detail", "View inference service"),
  inspire_models: d("tool.title.models", "View models"),
  inspire_notebook: d("tool.title.notebooks", "View notebooks"),

  // Inspire variant keys for getToolInfo dynamic title selection
  inspire_config_set_default: d("tool.title.set-default", "Set Default"),
  inspire_config_sii_defaults: d("tool.title.sii-defaults", "View SII defaults"),
  inspire_login_harbor: d("tool.title.harbor-login", "Log in to Harbor"),
  inspire_login_sii: d("tool.title.sii-login", "Log in to SII"),
  inspire_images_detail: d("tool.title.image-detail", "View image details"),
  inspire_images_search: d("tool.title.search-images", "Search Images"),
  inspire_submit_gpu: d("tool.title.submit-gpu-job", "Submit GPU Job"),
  inspire_stop_job: d("tool.title.stop-job", "Stop Job"),
  inspire_stop_batch: d("tool.title.batch-stop", "Batch Stop"),
  inspire_logs_download: d("tool.title.download-logs", "Download Logs"),
  inspire_logs_view: d("tool.title.job-logs", "View job logs"),
  inspire_inference_deploy: d("tool.title.deploy-inference", "Deploy inference service"),
  inspire_inference_stop: d("tool.title.stop-inference", "Stop inference service"),
  inspire_inference_detail: d("tool.title.inference-detail", "View inference service"),
  inspire_models_detail: d("tool.title.model-detail", "View model details"),
  inspire_models_register: d("tool.title.register-model", "Register Model"),
  inspire_models_delete: d("tool.title.delete-model", "Delete Model"),
  inspire_models_list: d("tool.title.models", "View models"),
  inspire_notebook_start: d("tool.title.start-notebook", "Start Notebook"),
  inspire_notebook_stop: d("tool.title.stop-notebook", "Stop Notebook"),
  inspire_notebook_create: d("tool.title.create-notebook", "Create Notebook"),
  inspire_notebook_detail: d("tool.title.notebook-detail", "View notebook details"),
  inspire_notebook_list: d("tool.title.notebooks", "View notebooks"),

  // Dynamic tool-state labels used by standard.tsx renders
  look_at_timed_out: d("tool.title.analysis-timed-out", "Analysis timed out"),
  note_write_created: d("tool.title.note-created", "Created"),
  note_write_appended: d("tool.title.note-appended", "Appended"),
  note_write_replaced: d("tool.title.note-replaced", "Replaced"),
  memory_write_similar_found: d("tool.title.memory-similar-found", "Similar found"),
  memory_write_stored: d("tool.title.memory-stored", "Stored"),
  patch_generating: d("tool.title.patch-generating", "Generating patch…"),
  patch_applied: d("tool.title.patch-applied", "Applied"),
}

// ── Classifier category labels ──────────────────────────────────────
export const CLASSIFIER_LABEL_DESC: Record<string, MessageDescriptor> = {
  "file-read": d("classifier.label.file-read", "Read file"),
  "file-write": d("classifier.label.file-write", "Write file"),
  shell: d("classifier.label.shell", "Execute command"),
  search: d("classifier.label.search", "Search"),
  web: d("classifier.label.web", "Access web"),
  browser: d("classifier.label.browser", "Control browser"),
  memory: d("classifier.label.memory", "Manage memories"),
  note: d("classifier.label.note", "Manage notes"),
  blueprint: d("classifier.label.blueprint", "Manage Blueprints"),
  task: d("classifier.label.task", "Execute task"),
  dag: d("classifier.label.dag", "Manage DAG"),
  schedule: d("classifier.label.schedule", "Manage schedule"),
  session: d("classifier.label.session", "Manage sessions"),
  "session-control": d("classifier.label.session-control", "Manage session"),
  community: d("classifier.label.community", "Access Agora"),
  network: d("classifier.label.network", "Manage connection"),
  analyze: d("classifier.label.analyze", "Analyze content"),
  config: d("classifier.label.config", "Change settings"),
  communication: d("classifier.label.communication", "Send content"),
  skill: d("classifier.label.skill", "Use skill"),
  research: d("classifier.label.research", "Conduct research"),
  generic: d("classifier.label.generic", "Call tool"),
}

// ── Special user message labels ─────────────────────────────────────
export const SPECIAL_USER_LABEL_DESC: Record<string, MessageDescriptor> = {
  blueprint: d("special-user.label.blueprint", "Blueprint"),
  "blueprint.continue": d("special-user.label.blueprint-continue", "Blueprint · Continue"),
  "blueprint.changes": d("special-user.label.blueprint-changes", "Blueprint · Changes requested"),
  "blueprint.completed": d("special-user.label.blueprint-completed", "Blueprint · Completed"),
  plan: d("special-user.label.plan", "Plan"),
  lattice: d("special-user.label.lattice", "Lattice"),
  lightloop: d("special-user.label.light-loop", "Light Loop"),
  workflow: d("special-user.label.workflow", "Workflow"),
  "lightloop.continue": d("special-user.label.lightloop-continue", "Light Loop · Continue"),
  "status.approved": d("special-user.status.approved", "Approved"),
  "status.changes": d("special-user.status.changes-requested", "Changes requested"),
  "lattice.continue": d("special-user.label.lattice-continue", "Lattice · Continue"),
}

// ── Session review chrome ───────────────────────────────────────────
export const SESSION_REVIEW_DESC = {
  title: d("session-review.title", "Session changes"),
  unified: d("session-review.unified", "Unified"),
  split: d("session-review.split", "Split"),
  collapseAll: d("session-review.collapse-all", "Collapse all"),
  expandAll: d("session-review.expand-all", "Expand all"),
} as const

// ── Session resonance popover ───────────────────────────────────────
export const RESONANCE_DESC = {
  title: d("resonance.title", "Resonance"),
  copyAll: d("resonance.copy-all", "Copy all"),
  copyFail: d("resonance.copy-fail", "Unable to copy resonance context."),
  memories: d("resonance.memories", "Memories"),
  experiences: d("resonance.experiences", "Experiences"),
  empty: d("resonance.empty", "No resonance for this turn"),
} as const

// ── DAG graph chrome ────────────────────────────────────────────────
export const DAG_CHROME_DESC = {
  done: d("dag.chrome.done", "done"),
  running: d("dag.chrome.running", "running"),
  pending: d("dag.chrome.pending", "pending"),
  blocked: d("dag.chrome.blocked", "blocked"),
  failed: d("dag.chrome.failed", "failed"),
  focus: d("dag.chrome.focus", "Focus"),
  nodeMetadata: d("dag.chrome.node-metadata", "Node metadata"),
  fit: d("dag.chrome.fit", "Fit"),
  openSession: d("dag.chrome.open-session", "Open session"),
  closeDetails: d("dag.chrome.close-details", "Close node details"),
  hint: d("dag.chrome.hint", "Drag to pan · Ctrl/\u2318 + wheel to zoom · Double-click to focus"),
  worktree: d("dag.chrome.worktree", "Worktree"),
  result: d("dag.chrome.result", "Result"),
  task: d("dag.chrome.task", "Task"),
  session: d("dag.chrome.session", "Session"),
  deps: d("dag.chrome.deps", "Deps"),
} as const

// ── Body primitives ─────────────────────────────────────────────────
export const BODY_PRIMITIVES_DESC = {
  conflictTitle: d("body-primitives.conflict-title", "Conflict markers detected"),
  conflictDetail: d(
    "body-primitives.conflict-detail",
    "{count} file or region{count, plural, one {} other {s}} may need resolution before precise edits.",
  ),
  error: d("body-primitives.diagnostic-error", "Error"),
} as const

// ── Turn change summary chrome ──────────────────────────────────────
export const TURN_CHANGE_DESC = {
  reviewChanges: d("turn-change.review-changes", "Review changes"),
  binary: d("turn-change.binary", "Binary"),
  calculating: d("turn-change.calculating", "Calculating file changes…"),
  calculationFailed: d("turn-change.calculation-failed", "Couldn’t calculate file changes"),
} as const

// ── Session turn chrome ─────────────────────────────────────────────
export const SESSION_TURN_DESC = {
  rewind: d("session-turn.rewind", "Rewind"),
  rewindTitle: d("session-turn.rewind-title", "Rewind to before this message"),
  completed: d("session-turn.completed", "Completed"),
  copyMarkdown: d("session-turn.copy-markdown", "Copy Markdown"),
  copied: d("session-turn.copied", "Copied!"),
  copyFailure: d("session-turn.copy-failure", "Unable to copy the message."),
  input: d("session-turn.token-input", "input"),
  cacheRead: d("session-turn.token-cache-read", "cache read"),
  cacheWrite: d("session-turn.token-cache-write", "cache write"),
  output: d("session-turn.token-output", "output"),
  reasoning: d("session-turn.token-reasoning", "reasoning"),
} as const

// ── Tool misc labels ────────────────────────────────────────────────
export const TOOL_MISC_DESC = {
  htmlPreview: d("tool.misc.html-preview", "HTML preview"),
  backgroundTask: d("tool.misc.background-task", "background"),
  files: d("tool.misc.files", "files"),
  ready: d("tool.misc.ready", "Ready"),
  updated: d("tool.misc.updated", "updated"),
  visibleBackgroundTasks: d("tool.misc.visible-background-tasks", "Visible background tasks"),
  requested: d("tool.misc.requested", "Requested"),
  executed: d("tool.misc.executed", "Executed"),
  cascaded: d("tool.misc.cascaded", "Cascaded"),
  changedFields: d("tool.misc.changed-fields", "Changed Fields"),
  liveApplied: d("tool.misc.live-applied", "Live Applied"),
  restartRequired: d("tool.misc.restart-required", "Restart Required"),
  warnings: d("tool.misc.warnings", "Warnings"),
} as const

// ── Markdown ────────────────────────────────────────────────────────
export const MARKDOWN_DESC = {
  previewLabel: d("markdown.preview-label", "Preview"),
  diffLabel: d("markdown.diff-label", "Apply diff"),
} as const

export const LIST_DESC = {
  noItems: d("list.no-items", "No items"),
  noMatchedItems: d("list.no-matched-items", "No matched items"),
  forLabel: d("list.for-label", "for"),
} as const

// ── Logo ────────────────────────────────────────────────────────────
export const LOGO_DESC = {
  title: d("logo.title", "Synergy"),
} as const

// ── Countdown ───────────────────────────────────────────────────────
export const COUNTDOWN_DESC = {
  timeoutLabel: d("countdown.timeout-label", "{remaining}s timeout"),
} as const

// ── Anchored tool card ──────────────────────────────────────────────
export const ANCHORED_TOOL_DESC = {
  truncatedNote: d("anchored-tool.truncated-note", "{count} more lines"),
  emptyPreview: d("anchored-tool.empty-preview", "No preview available"),
} as const

export const ANYSEARCH_DESC = {
  search: d("anysearch.title.search", "Search with Anysearch"),
  batchSearch: d("anysearch.title.batch-search", "Batch search with Anysearch"),
  extract: d("anysearch.title.extract", "Extract content with Anysearch"),
  domains: d("anysearch.title.domains", "View search domains"),
} as const

// ── Message-part chrome ────────────────────────────────────────────
export const MESSAGE_PART_DESC = {
  diagnosticError: d("message-part.diagnostic-error", "Error"),
  searchEarlyStop: d("message-part.search-early-stop", "Search ended early"),
  searchReflection: d("message-part.search-reflection", "Search process"),
  showMore: d("message-part.show-more", "Show more"),
  showLess: d("message-part.show-less", "Show less"),
  partRenderError: d("message-part.part-render-error", "Couldn’t display this content:"),
  copyMessage: d("message-part.copy-message", "Copy message"),
  messageCopied: d("message-part.message-copied", "Message copied"),
  copyFailure: d("message-part.copy-failure", "Unable to copy the message."),
  noteLabel: d("message-part.note-label", "Note"),
  sessionLabel: d("message-part.session-label", "Session"),
  untitled: d("message-part.untitled", "Untitled"),
} as const

// ── Diagram ─────────────────────────────────────────────────────────
export const DIAGRAM_DESC = {
  totalLabel: d("diagram.total-label", "Total"),
} as const

// ── Diff preview ────────────────────────────────────────────────────
export const DIFF_DESC = {
  fileDiffPreview: d("diff.file-diff-preview", "File diff preview"),
} as const

// ── Anchored-tool chip labels ──────────────────────────────────────
export const ANCHORED_CHIP_DESC = {
  tag: d("anchored-chip.tag", "tag"),
  conflict: d("anchored-chip.conflict", "conflict"),
  recovered: d("anchored-chip.recovered", "recovered"),
  resolvedConflict: d("anchored-chip.resolved-conflict", "resolved conflict"),
} as const

// ── Session-turn mailbox ───────────────────────────────────────────
export const MAILBOX_DESC = {
  from: d("mailbox.from", "From"),
  anotherSession: d("mailbox.another-session", "another session"),
} as const

// ── Markdown code/latex copy ───────────────────────────────────────
export const CODE_COPY_DESC = {
  copyLaTeX: d("markdown.copy-latex", "Copy LaTeX"),
  copyLaTeXFail: d("markdown.copy-latex-fail", "Unable to copy the LaTeX source."),
  copyCode: d("markdown.copy-code", "Copy code"),
  copyCodeFail: d("markdown.copy-code-fail", "Unable to copy the code block."),
  copied: d("markdown.copied", "Copied"),
  copyFailed: d("markdown.copy-failed", "Copy failed"),
  copy: d("markdown.copy", "Copy"),
  failed: d("markdown.failed", "Failed"),
} as const

// ── Tool label descriptors (ICU plural count labels) ─────────────────
export const TOOL_LABEL_DESC = {
  sessions: d("tool.label.sessions", "{count, plural, one {# session} other {# sessions}}"),
  scopes: d("tool.label.scopes", "{count, plural, one {# scope} other {# scopes}}"),
  tasks: d("tool.label.tasks", "{count, plural, one {# task} other {# tasks}}"),
  results: d("tool.label.results", "{count, plural, one {# result} other {# results}}"),
  items: d("tool.label.items", "{count, plural, one {# item} other {# items}}"),
  files: d("tool.label.files", "{count, plural, one {# file} other {# files}}"),
  matches: d("tool.label.matches", "{count, plural, one {# match} other {# matches}}"),
  runs: d("tool.label.runs", "{count, plural, one {# run} other {# runs}}"),
  changes: d("tool.label.changes", "{count, plural, one {# change} other {# changes}}"),
  notes: d("tool.label.notes", "{count, plural, one {# note} other {# notes}}"),
  blueprints: d("tool.label.blueprints", "{count, plural, one {# blueprint} other {# blueprints}}"),
  targets: d("tool.label.targets", "{count, plural, one {# target} other {# targets}}"),
  posts: d("tool.label.posts", "{count, plural, one {# post} other {# posts}}"),
  memories: d("tool.label.memories", "{count, plural, one {# memory} other {# memories}}"),
  found: d("tool.label.found", "{count} found"),
  // Composite count labels
  matchesInNotes: d(
    "tool.label.matches-in-notes",
    "{matchCount, plural, one {# match} other {# matches}} in {noteCount, plural, one {# note} other {# notes}}",
  ),
  matchesInBlueprints: d(
    "tool.label.matches-in-blueprints",
    "{matchCount, plural, one {# match} other {# matches}} in {noteCount, plural, one {# blueprint} other {# blueprints}}",
  ),
  // Question subtitle
  askedCount: d("tool.label.asked-count", "Asked {count, plural, one {# question} other {# questions}}"),
} as const
