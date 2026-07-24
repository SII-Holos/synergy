import type { IconName } from "../icon"
import type { MessageDescriptor } from "@lingui/core"
import { getSemanticIcon } from "../semantic-icon"
import { CLASSIFIER_LABEL_DESC, TOOL_LABEL_DESC, TOOL_TITLE_DESC } from "../tool-title-descriptors"

/**
 * Semantic tool classification system.
 *
 * Self-contained flat mapping from tool name → SemanticCategory.
 *
 * The pipeline:
 *   1. Exact name lookup in TOOL_CATEGORIES
 *   2. Pattern fallback (regex on tool name)
 *   3. Input-shape heuristic (parameter names)
 *   4. Fallback to "generic"
 */

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
  | "community"
  | "network"
  | "analyze"
  | "config"
  | "communication"
  | "skill"
  | "research"
  | "generic"

export interface CategorySpec {
  icon: IconName
  descriptor: MessageDescriptor
  /** Human-readable label for the category (used as fallback title) */
  subtitleKeys: string[]
  /** Ordered list of input keys to try for subtitle extraction */
  argsKeys?: string[]
  /** Optional extra keys for args badges */
}

export const CATEGORIES: Record<SemanticCategory, CategorySpec> = {
  "file-read": {
    icon: "glasses",
    descriptor: CLASSIFIER_LABEL_DESC["file-read"],
    subtitleKeys: ["filePath", "file_path", "path", "filename"],
  },
  "file-write": {
    icon: "file-pen",
    descriptor: CLASSIFIER_LABEL_DESC["file-write"],
    subtitleKeys: ["filePath", "file_path", "path", "filename"],
  },
  shell: {
    icon: "terminal",
    descriptor: CLASSIFIER_LABEL_DESC["shell"],
    subtitleKeys: ["description", "command", "cmd", "script"],
  },
  search: {
    icon: "regex",
    descriptor: CLASSIFIER_LABEL_DESC["search"],
    subtitleKeys: ["pattern", "query", "regex", "search"],
    argsKeys: ["include", "lang", "language"],
  },
  web: {
    icon: "globe",
    descriptor: CLASSIFIER_LABEL_DESC["web"],
    subtitleKeys: ["url", "query"],
    argsKeys: ["format", "categories"],
  },
  browser: {
    icon: "panel-right",
    descriptor: CLASSIFIER_LABEL_DESC["browser"],
    subtitleKeys: ["url", "title", "action", "type"],
    argsKeys: ["action", "kind", "captureKind"],
  },
  memory: {
    icon: "brain",
    descriptor: CLASSIFIER_LABEL_DESC["memory"],
    subtitleKeys: ["query", "title"],
  },
  note: {
    icon: "notebook-pen",
    descriptor: CLASSIFIER_LABEL_DESC["note"],
    subtitleKeys: ["title", "pattern"],
    argsKeys: ["scope", "mode"],
  },
  blueprint: {
    icon: getSemanticIcon("blueprint.main"),
    descriptor: CLASSIFIER_LABEL_DESC["blueprint"],
    subtitleKeys: ["title", "loopID", "id"],
    argsKeys: ["status"],
  },
  task: {
    icon: "list-todo",
    descriptor: CLASSIFIER_LABEL_DESC["task"],
    subtitleKeys: ["description", "prompt"],
  },
  dag: {
    icon: "route",
    descriptor: CLASSIFIER_LABEL_DESC["dag"],
    subtitleKeys: [],
  },
  schedule: {
    icon: "clipboard-check",
    descriptor: CLASSIFIER_LABEL_DESC["schedule"],
    subtitleKeys: ["title", "id"],
    argsKeys: ["status"],
  },
  session: {
    icon: "message-square",
    descriptor: CLASSIFIER_LABEL_DESC["session"],
    subtitleKeys: ["target", "pattern"],
    argsKeys: ["scope"],
  },
  "session-control": {
    icon: "radar",
    descriptor: CLASSIFIER_LABEL_DESC["session-control"],
    subtitleKeys: ["target"],
    argsKeys: ["action"],
  },
  community: {
    icon: "compass",
    descriptor: CLASSIFIER_LABEL_DESC["community"],
    subtitleKeys: ["keyword", "post_id", "title", "comment"],
  },
  network: {
    icon: "cable",
    descriptor: CLASSIFIER_LABEL_DESC["network"],
    subtitleKeys: ["linkID"],
    argsKeys: ["action"],
  },
  analyze: {
    icon: "scan-eye",
    descriptor: CLASSIFIER_LABEL_DESC["analyze"],
    subtitleKeys: ["goal", "file_path", "description"],
  },
  config: {
    icon: "rotate-cw",
    descriptor: CLASSIFIER_LABEL_DESC["config"],
    subtitleKeys: ["target", "name", "reason"],
  },
  communication: {
    icon: "mail",
    descriptor: CLASSIFIER_LABEL_DESC["communication"],
    subtitleKeys: ["to", "target", "subject", "output_path", "input_paths", "prompt"],
  },
  skill: {
    icon: "sparkles",
    descriptor: CLASSIFIER_LABEL_DESC["skill"],
    subtitleKeys: ["name"],
  },
  research: {
    icon: "flask-conical",
    descriptor: CLASSIFIER_LABEL_DESC["research"],
    subtitleKeys: ["action", "title", "project"],
    argsKeys: ["action"],
  },
  generic: {
    icon: "settings",
    descriptor: CLASSIFIER_LABEL_DESC["generic"],
    subtitleKeys: [],
  },
}

// ── Flat tool name → category map ────────────────────────────────────

const TOOL_CATEGORIES: Record<string, SemanticCategory> = {
  // search
  websearch: "web",
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
  arxiv_search: "search",
  arxiv_download: "search",
  grep: "search",
  file_search: "search",
  scan_files: "search",
  ast_grep: "search",
  parse_code: "analyze",
  glob: "search",
  session_search: "session",
  note_search: "note",
  memory_search: "memory",
  memory_get: "memory",

  // code
  read: "file-read",
  view_file: "file-read",
  list: "file-read",
  look_at: "analyze",
  view_image: "analyze",
  scan_document: "analyze",
  edit: "file-write",
  revise_file: "file-write",
  write: "file-write",
  save_file: "file-write",
  bash: "shell",
  process: "shell",
  lsp: "analyze",

  // knowledge
  memory_write: "memory",
  memory_edit: "memory",
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

  // orchestration
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
  todowrite: "dag",
  todoread: "dag",
  session_list: "session",
  scope_list: "session",
  session_read: "session",
  session_send: "session",
  session_control: "session-control",
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

  // platform
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

  // communication
  question: "communication",
  email_send: "communication",
  email_read: "communication",
  clarus_submit_task_result: "communication",
  clarus_extend_task: "communication",
  openai_image_gen: "communication",
  openai_image_edit: "communication",
  diagram: "analyze",
  render: "analyze",
  attach: "communication",

  // qzcli / MCP tools
  qzcli_qz_auth_login: "config",
  qzcli_qz_set_cookie: "config",
  qzcli_qz_list_workspaces: "config",
  qzcli_qz_refresh_resources: "config",
  qzcli_qz_get_availability: "analyze",
  qzcli_qz_list_jobs: "shell",
  qzcli_qz_get_job_detail: "analyze",
  qzcli_qz_stop_job: "shell",
  qzcli_qz_get_usage: "analyze",
  qzcli_qz_inspect_status_catalog: "analyze",
  qzcli_qz_track_job: "task",
  qzcli_qz_list_tracked_jobs: "task",
  qzcli_qz_create_job: "shell",
  qzcli_qz_create_hpc_job: "shell",
  qzcli_qz_get_hpc_usage: "analyze",
  "context7_resolve-library-id": "search",
  "context7_query-docs": "web",
}

// ── Pattern fallbacks ────────────────────────────────────────────────

const PATTERN_FALLBACKS: { pattern: RegExp; category: SemanticCategory }[] = [
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
  { pattern: /^diagram/i, category: "analyze" },
  { pattern: /^attach/i, category: "communication" },
]

// ── Input-shape heuristics ───────────────────────────────────────────

const INPUT_HEURISTICS: { keys: string[]; writeHint?: string[]; category: SemanticCategory }[] = [
  { keys: ["command", "cmd", "script"], category: "shell" },
  {
    keys: ["filePath", "file_path", "output_path", "outputPath"],
    writeHint: ["content", "newString", "oldString", "diff", "prompt", "input_paths"],
    category: "file-write",
  },
  { keys: ["filePath", "file_path", "path"], category: "file-read" },
  { keys: ["query", "pattern", "regex", "search"], category: "search" },
  { keys: ["url", "href", "endpoint"], category: "web" },
]

// ── Classifier ──────────────────────────────────────────────────────

export interface ClassifiedTool {
  category: SemanticCategory
  spec: CategorySpec
  /** English fallback or pass-through title. */
  title: string
  /** Static descriptor for Synergy-owned tools; absent for external tool names. */
  titleDescriptor?: MessageDescriptor
  subtitle?: string
  args?: string[]
  /** ICU plural count descriptor to resolve at render time, plus values. */
  countDescriptor?: MessageDescriptor
  countValues?: Record<string, number>
}

export function classifyTool(
  toolName: string,
  input: Record<string, any> = {},
  metadata: Record<string, any> = {},
): ClassifiedTool {
  // Layer 1: flat lookup
  let category: SemanticCategory | undefined = TOOL_CATEGORIES[toolName]

  // Layer 2: pattern fallback
  if (!category) {
    for (const rule of PATTERN_FALLBACKS) {
      if (rule.pattern.test(toolName)) {
        category = rule.category
        break
      }
    }
  }

  // Layer 3: input heuristic
  if (!category) {
    for (const rule of INPUT_HEURISTICS) {
      const hasKey = rule.keys.some((k) => input[k] !== undefined)
      if (!hasKey) continue

      if (rule.writeHint) {
        const hasWriteHint = rule.writeHint.some((k) => input[k] !== undefined)
        category = hasWriteHint ? rule.category : "file-read"
      } else {
        category = rule.category
      }
      break
    }
  }

  // Fallback
  if (!category) category = "generic"

  const spec = CATEGORIES[category]

  const titleDescriptor = toolTitleDescriptor(toolName, spec)
  const title = titleDescriptor?.message ?? humanizeToolName(toolName)

  const subtitle = extractField(metadata, spec.subtitleKeys) ?? extractField(input, spec.subtitleKeys)

  const args = buildArgs(input, metadata, spec)
  const count = classifyCount(toolName, category, metadata)

  return { category, spec, title, titleDescriptor, subtitle, args, ...count }
}

function toolTitleDescriptor(name: string, spec: CategorySpec): MessageDescriptor | undefined {
  const exactDescriptor: MessageDescriptor | undefined = Object.hasOwn(TOOL_TITLE_DESC, name)
    ? TOOL_TITLE_DESC[name]
    : undefined
  if (exactDescriptor) return exactDescriptor
  return Object.hasOwn(TOOL_CATEGORIES, name) ? spec.descriptor : undefined
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim()
}

function extractField(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = input[key]
    if (typeof val === "string" && val.length > 0) return val
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") return val[0]
  }
  return undefined
}
type CountPresentation = Pick<ClassifiedTool, "countDescriptor" | "countValues">

const TOOL_COUNT_DESCRIPTORS: Partial<Record<string, MessageDescriptor>> = {
  session_list: TOOL_LABEL_DESC.sessions,
  scope_list: TOOL_LABEL_DESC.scopes,
  task_list: TOOL_LABEL_DESC.tasks,
  note_list: TOOL_LABEL_DESC.notes,
  worktree_list: TOOL_LABEL_DESC.targets,
}

const CATEGORY_COUNT_DESCRIPTORS: Partial<Record<SemanticCategory, MessageDescriptor>> = {
  session: TOOL_LABEL_DESC.sessions,
  note: TOOL_LABEL_DESC.notes,
  blueprint: TOOL_LABEL_DESC.blueprints,
  task: TOOL_LABEL_DESC.tasks,
  memory: TOOL_LABEL_DESC.results,
  search: TOOL_LABEL_DESC.results,
  community: TOOL_LABEL_DESC.posts,
  schedule: TOOL_LABEL_DESC.items,
  "file-read": TOOL_LABEL_DESC.files,
  "file-write": TOOL_LABEL_DESC.files,
}

function classifyCount(toolName: string, category: SemanticCategory, metadata: Record<string, any>): CountPresentation {
  const count = metadata.matchCount ?? metadata.count ?? metadata.total
  if (typeof count !== "number") return {}

  if (typeof metadata.noteCount === "number") {
    return {
      countDescriptor:
        category === "blueprint" || toolName.includes("blueprint")
          ? TOOL_LABEL_DESC.matchesInBlueprints
          : TOOL_LABEL_DESC.matchesInNotes,
      countValues: { matchCount: count, noteCount: metadata.noteCount },
    }
  }

  return {
    countDescriptor: TOOL_COUNT_DESCRIPTORS[toolName] ?? CATEGORY_COUNT_DESCRIPTORS[category] ?? TOOL_LABEL_DESC.items,
    countValues: { count },
  }
}

function buildArgs(
  input: Record<string, any>,
  metadata: Record<string, any>,
  spec: CategorySpec,
): string[] | undefined {
  const args: string[] = []

  if (spec.argsKeys) {
    for (const k of spec.argsKeys) {
      const v = input[k]
      if (typeof v === "string" && v.length > 0) args.push(v)
    }
  }

  const status = metadata.status ?? metadata.action
  if (typeof status === "string" && status.length > 0 && status.length < 20) {
    args.push(status.charAt(0).toUpperCase() + status.slice(1))
  }

  return args.length > 0 ? args : undefined
}

// Re-export for convenient access
export { CLASSIFIER_LABEL_DESC }
