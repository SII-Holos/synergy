import { z } from "zod"

export type ActivityDisplayMode = "full" | "balanced" | "minimal"

export type SemanticCategory =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "browser"
  | "web"
  | "memory"
  | "note"
  | "blueprint"
  | "task"
  | "dag"
  | "schedule"
  | "session"
  | "session-control"
  | "network"
  | "analyze"
  | "config"
  | "communication"
  | "skill"
  | "research"
  | "generic"

export type ActivityFamily =
  | "inspect-local"
  | "research-web"
  | "modify-files"
  | "execute"
  | "browser"
  | "delegate"
  | "produce"
  | "external-action"
  | "coordination"
  | "generic"

export const ACTIVITY_FAMILY_ORDER: readonly ActivityFamily[] = [
  "inspect-local",
  "research-web",
  "modify-files",
  "execute",
  "browser",
  "delegate",
  "produce",
  "external-action",
  "coordination",
  "generic",
]

export const MAX_ACTIVITY_GROUP_STEPS = 24

export const ActivitySummaryStateSchema = z.enum(["live", "stable", "fallback"])
export type ActivitySummaryState = z.infer<typeof ActivitySummaryStateSchema>

export const ActivityDerivedMetadataSchema = z.object({
  v: z.literal(1),
  seq: z.number().int().nonnegative(),
  reasoning: z
    .record(
      z.string(),
      z.object({
        state: ActivitySummaryStateSchema,
        text: z.string().max(280).optional(),
        source: z.enum(["nano", "partial-live"]).optional(),
        updatedAt: z.number(),
      }),
    )
    .optional(),
  groups: z
    .record(
      z.string(),
      z.object({
        state: ActivitySummaryStateSchema,
        signature: z.string().max(2_048).optional(),
        text: z.string().max(200).optional(),
        updatedAt: z.number(),
      }),
    )
    .optional(),
  now: z
    .object({
      text: z.string().max(120),
      source: z.enum(["reasoning", "group"]),
      updatedAt: z.number(),
    })
    .optional(),
})

export type ActivityDerivedMetadata = z.infer<typeof ActivityDerivedMetadataSchema>

const TOOL_CATEGORIES: Record<string, SemanticCategory> = {
  webfetch: "web",
  browser_navigation: "browser",
  browser_snapshot: "browser",
  browser_action: "browser",
  browser_wait: "browser",
  browser_read: "browser",
  browser_inspect: "browser",
  browser_screenshot: "browser",
  browser_eval: "browser",
  browser_console: "browser",
  browser_network: "browser",
  browser_performance: "browser",
  browser_audit: "browser",
  browser_emulate: "browser",
  browser_dialog: "browser",
  browser_upload: "browser",
  browser_downloads: "browser",
  browser_clipboard: "browser",
  browser_assets: "browser",
  browser_annotate: "browser",
  browser_view: "browser",
  grep: "search",
  file_search: "search",
  scan_files: "search",
  ast_grep: "search",
  parse_code: "analyze",
  glob: "search",
  read: "file-read",
  view_file: "file-read",
  list: "file-read",
  look_at: "analyze",
  view_image: "analyze",
  scan_document: "analyze",
  edit: "file-write",
  revise_file: "file-write",
  resolve_conflicts: "file-write",
  write: "file-write",
  save_file: "file-write",
  bash: "shell",
  process: "shell",
  lsp: "analyze",
  memory_search: "memory",
  memory_get: "memory",
  memory_write: "memory",
  memory_edit: "memory",
  note_search: "note",
  note_write: "note",
  note_edit: "note",
  note_list: "note",
  note_read: "note",
  note_archive: "note",
  note_delete: "note",
  blueprint_loop_stop: "blueprint",
  blueprint_loop_approve: "blueprint",
  blueprint_loop_reject: "blueprint",
  skill: "skill",
  task: "task",
  task_list: "task",
  task_output: "task",
  task_cancel: "task",
  loop_stop: "task",
  light_loop_approve: "task",
  light_loop_reject: "task",
  dagwrite: "dag",
  dagread: "dag",
  dagpatch: "dag",
  pathway_read: "dag",
  pathway_write: "dag",
  lattice_submit: "task",
  todowrite: "dag",
  todoread: "dag",
  session_list: "session",
  scope_list: "session",
  session_read: "session",
  session_search: "session",
  session_send: "session",
  session_control: "session-control",
  boss_spawn: "session",
  boss_assign: "session",
  boss_report: "session",
  boss_status: "session",
  boss_cancel: "session-control",
  boss_project: "session",
  channel_push: "communication",
  agenda_schedule: "schedule",
  agenda_watch: "schedule",
  agenda_list: "schedule",
  agenda_update: "schedule",
  agenda_cancel: "schedule",
  agenda_trigger: "schedule",
  agenda_logs: "schedule",
  research_init: "research",
  research_state: "research",
  research_idea: "research",
  research_plan: "research",
  research_experiment: "research",
  research_claim: "research",
  research_exhibit: "research",
  research_paper: "research",
  research_submission: "research",
  research_wiki: "research",
  research_timeline: "research",
  search_tools: "search",
  expand_tools: "config",
  runtime_reload: "config",
  profile_get: "config",
  profile_update: "config",
  worktree_enter: "config",
  worktree_leave: "config",
  worktree_list: "config",
  connect: "network",
  inspire_status: "config",
  inspire_config: "config",
  inspire_login: "config",
  inspire_submit: "shell",
  inspire_submit_hpc: "shell",
  inspire_jobs: "analyze",
  inspire_job_detail: "analyze",
  inspire_logs: "analyze",
  inspire_metrics: "analyze",
  inspire_stop: "shell",
  inspire_images: "analyze",
  inspire_image_push: "shell",
  inspire_notebook: "shell",
  inspire_models: "analyze",
  inspire_inference: "shell",
  question: "communication",
  email_send: "communication",
  email_read: "communication",
  clarus_submit_task_result: "communication",
  clarus_extend_task: "communication",
  github_deliver_fix: "communication",
  openai_image_gen: "communication",
  openai_image_edit: "communication",
  render: "analyze",
  attach: "communication",
  response_card: "communication",
  "context7_resolve-library-id": "search",
  "context7_query-docs": "web",
}

export function semanticCategoryForKnownTool(toolName: string): SemanticCategory | undefined {
  return TOOL_CATEGORIES[toolName]
}

const PATTERN_FALLBACKS: readonly { pattern: RegExp; category: SemanticCategory }[] = [
  { pattern: /^(web)?search/i, category: "web" },
  { pattern: /^(web)?fetch/i, category: "web" },
  { pattern: /^browser[-_]/i, category: "browser" },
  { pattern: /^arxiv/i, category: "search" },
  {
    pattern: /^(grep|glob|find|ripgrep|rg|search[-_]?files?|codebase[-_]?search|file[-_]?search)/i,
    category: "search",
  },
  { pattern: /^(read|get|load|fetch|cat|view|head|tail)[-_]?file/i, category: "file-read" },
  { pattern: /^(list|ls|dir)[-_]?(dir|files?|folder)?$/i, category: "file-read" },
  { pattern: /^(write|create|edit|update|patch|modify|replace|insert|append)[-_]?file/i, category: "file-write" },
  { pattern: /^(apply[-_]?diff|save[-_]?file)/i, category: "file-write" },
  { pattern: /^(run|exec|execute|shell|bash|sh|cmd|terminal|command)/i, category: "shell" },
  { pattern: /[-_](command|exec|shell|terminal)$/i, category: "shell" },
  { pattern: /^(look|analyze|vision|describe|inspect|examine)/i, category: "analyze" },
  { pattern: /^(memory|library|remember|recall)/i, category: "memory" },
  { pattern: /^note[-_]/i, category: "note" },
  { pattern: /^skill/i, category: "skill" },
  { pattern: /^blueprint[-_]/i, category: "blueprint" },
  { pattern: /^(task|delegate|dispatch|spawn)/i, category: "task" },
  { pattern: /^(dag|plan)/i, category: "dag" },
  { pattern: /^todo/i, category: "dag" },
  { pattern: /^session[-_]/i, category: "session" },
  { pattern: /^scope[-_]/i, category: "session" },
  { pattern: /^(agenda|schedule|cron|timer|remind)/i, category: "schedule" },
  { pattern: /^research[-_]/i, category: "research" },
  { pattern: /^(config|setting|profile|runtime)/i, category: "config" },
  { pattern: /^inspire[-_]/i, category: "shell" },
  { pattern: /^(email|mail)/i, category: "communication" },
  { pattern: /^(send|notify|message)/i, category: "communication" },
  { pattern: /^question/i, category: "communication" },
  { pattern: /^(openai[-_])?image[-_](gen|edit)/i, category: "communication" },
  { pattern: /^attach/i, category: "communication" },
]

const ACTIVITY_FAMILIES = new Set<ActivityFamily>(ACTIVITY_FAMILY_ORDER)
const EXTERNAL_ACTION_TOOLS = new Set([
  "email_send",
  "email_mark_read",
  "session_send",
  "clarus_submit_task_result",
  "clarus_extend_task",
  "github_deliver_fix",
  "question",
  "agenda_schedule",
  "agenda_update",
  "agenda_cancel",
  "calendar_create",
  "calendar_update",
  "calendar_delete",
  "inspire_submit",
  "inspire_submit_hpc",
  "inspire_stop",
  "inspire_image_push",
  "inspire_inference",
  "inspire_notebook",
])
const PRODUCTION_COMMUNICATION_TOOLS = new Set([
  "attach",
  "response_card",
  "openai_image_gen",
  "openai_image_edit",
  "generate_image",
  "edit_image",
])
const COORDINATION_RECEIPT_TOOLS = new Set([
  "dagwrite",
  "dagpatch",
  "session_control",
  "agenda_trigger",
  "task_cancel",
  "loop_stop",
  "light_loop_approve",
  "light_loop_reject",
  "blueprint_loop_approve",
  "blueprint_loop_reject",
  "blueprint_loop_stop",
])

const ACTIVITY_PRESENTATION_BOUNDARY_TOOLS = new Set(["render"])

// Built-in remote MCP search families stay visible as individual cards in
// the activity timeline instead of being folded into grouped summary rows.
// Their renderers are presentation boundaries with per-query structure the
// user should be able to inspect after the turn (the same reason `render`
// is a boundary above).
const ACTIVITY_PRESENTATION_BOUNDARY_PREFIXES = ["mcp__anysearch__", "mcp__scholight__"]

function isPresentationBoundaryTool(tool: string): boolean {
  if (ACTIVITY_PRESENTATION_BOUNDARY_TOOLS.has(tool)) return true
  return ACTIVITY_PRESENTATION_BOUNDARY_PREFIXES.some((prefix) => tool.startsWith(prefix))
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function toolDisplayMetadata(metadata: unknown): Record<string, unknown> | undefined {
  const display = record(record(metadata).display)
  return Object.keys(display).length > 0 ? display : undefined
}

export function toolDisplayPolicy(metadata: unknown): { toolCardHidden: boolean; mediaGeneration: boolean } {
  const display = toolDisplayMetadata(metadata)
  return {
    toolCardHidden: display?.toolCard === "hidden",
    mediaGeneration: display?.kind === "media-generation",
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const text = value.trim()
    if (text) return text
  }
}

export function isActivityGroupableTool(tool: string, metadata: Record<string, unknown> = {}): boolean {
  if (isPresentationBoundaryTool(tool)) return false
  const policy = toolDisplayPolicy(metadata)
  return !policy.toolCardHidden && !policy.mediaGeneration
}

export function resolveActivityDisplay(value: unknown): ActivityDisplayMode {
  return value === "full" || value === "minimal" || value === "balanced" ? value : "balanced"
}

export function classifySemanticCategory(toolName: string, input: Record<string, unknown> = {}): SemanticCategory {
  const exact = semanticCategoryForKnownTool(toolName)
  if (exact) return exact

  for (const rule of PATTERN_FALLBACKS) {
    if (rule.pattern.test(toolName)) return rule.category
  }

  if (input.command !== undefined || input.cmd !== undefined || input.script !== undefined) return "shell"
  const file = input.filePath ?? input.file_path ?? input.output_path ?? input.outputPath
  if (file !== undefined) {
    const write = ["content", "newString", "oldString", "diff", "prompt", "input_paths"].some(
      (key) => input[key] !== undefined,
    )
    return write ? "file-write" : "file-read"
  }
  if (input.path !== undefined) return "file-read"
  if (["query", "pattern", "regex", "search"].some((key) => input[key] !== undefined)) return "search"
  if (["url", "href", "endpoint"].some((key) => input[key] !== undefined)) return "web"
  return "generic"
}

function metadataFamily(metadata: Record<string, unknown>): ActivityFamily | undefined {
  const display = record(metadata.display)
  const value = firstString(metadata.activityFamily, display.activityFamily)
  return value && ACTIVITY_FAMILIES.has(value as ActivityFamily) ? (value as ActivityFamily) : undefined
}

export function activityFamilyForTool(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): ActivityFamily {
  if (EXTERNAL_ACTION_TOOLS.has(tool)) return "external-action"
  if (PRODUCTION_COMMUNICATION_TOOLS.has(tool)) return "produce"
  if (COORDINATION_RECEIPT_TOOLS.has(tool)) return "coordination"
  const override = metadataFamily(metadata)
  if (override) return override

  switch (classifySemanticCategory(tool, input)) {
    case "file-read":
    case "search":
    case "memory":
      return "inspect-local"
    case "web":
    case "research":
      return "research-web"
    case "file-write":
      return "modify-files"
    case "shell":
      return "execute"
    case "browser":
      return "browser"
    case "task":
      return "delegate"
    case "analyze":
    case "note":
    case "blueprint":
      return "produce"
    case "communication":
      return "external-action"
    case "dag":
    case "schedule":
    case "session":
    case "session-control":
    case "network":
    case "config":
    case "skill":
      return "coordination"
    case "generic":
      return "generic"
  }
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "")
}

function pathScope(value: string): string {
  const normalized = normalizedPath(value)
  const slash = normalized.lastIndexOf("/")
  if (slash <= 0) return normalized
  return normalized.slice(0, slash)
}

function fileActivityScope(
  value: string,
  workspaceRoot: string | undefined,
  family: ActivityFamily | undefined,
): string {
  if (family !== "modify-files" || !workspaceRoot) return pathScope(value)
  const file = normalizedPath(value)
  const root = normalizedPath(workspaceRoot)
  if (file !== root && !file.startsWith(`${root}/`)) return pathScope(file)
  const relative = file.slice(root.length).replace(/^\/+/, "")
  const segments = relative.split("/").filter(Boolean)
  if (segments.length === 0) return root
  if (segments.length === 1) return root
  const depth = segments[0] === "packages" && segments[1] ? 2 : 1
  return `${root}/${segments.slice(0, depth).join("/")}`
}

function urlScope(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

export function activityScopeForTool(
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
  options: { family?: ActivityFamily; workspaceRoot?: string } = {},
): { key: string; label?: string } {
  const explicit = firstString(metadata.activityScope, metadata.scopeKey)
  if (explicit) return { key: `scope:${explicit}`, label: explicit }

  const file = firstString(
    input.filePath,
    input.file_path,
    input.outputPath,
    input.output_path,
    input.filename,
    input.path,
    metadata.filePath,
    metadata.path,
  )
  if (file) {
    const scope = fileActivityScope(file, options.workspaceRoot, options.family)
    return { key: `path:${scope}`, label: scope }
  }

  const url = firstString(input.url, input.href, input.endpoint, metadata.url, metadata.href)
  if (url) {
    const origin = urlScope(url)
    if (origin) return { key: `url:${origin}`, label: origin }
  }

  const page = firstString(input.pageID, input.pageId, input.targetID, metadata.pageID, metadata.targetID)
  if (page) return { key: `page:${page}`, label: page }

  const task = firstString(
    input.task_id,
    input.taskID,
    input.session_id,
    input.sessionID,
    input.id,
    metadata.task_id,
    metadata.taskID,
  )
  if (task) return { key: `task:${task}`, label: task }

  const artifact = firstString(input.name, input.title, input.outputItem, metadata.name, metadata.title)
  if (artifact) return { key: `artifact:${artifact}`, label: artifact }
  return { key: "" }
}

export function activityGroupKey(
  messageID: string,
  family: ActivityFamily,
  scopeKey: string,
  firstPartID: string,
): string {
  return `activity:${messageID}:${family}:${scopeKey}:${firstPartID}`
}

export function isActivityReceiptTool(tool: string, family: ActivityFamily): boolean {
  return (
    family === "external-action" ||
    PRODUCTION_COMMUNICATION_TOOLS.has(tool) ||
    COORDINATION_RECEIPT_TOOLS.has(tool) ||
    tool === "dagread"
  )
}
