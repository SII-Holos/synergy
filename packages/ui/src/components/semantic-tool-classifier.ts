import type { IconName } from "./icon"

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
  | "web"
  | "memory"
  | "note"
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
  label: string
  /** Human-readable label for the category (used as fallback title) */
  subtitleKeys: string[]
  /** Ordered list of input keys to try for subtitle extraction */
  argsKeys?: string[]
  /** Optional extra keys for args badges */
}

export const CATEGORIES: Record<SemanticCategory, CategorySpec> = {
  "file-read": {
    icon: "glasses",
    label: "Read",
    subtitleKeys: ["filePath", "file_path", "path", "filename"],
  },
  "file-write": {
    icon: "file-pen",
    label: "Write",
    subtitleKeys: ["filePath", "file_path", "path", "filename"],
  },
  shell: {
    icon: "terminal",
    label: "Shell",
    subtitleKeys: ["description", "command", "cmd", "script"],
  },
  search: {
    icon: "regex",
    label: "Search",
    subtitleKeys: ["pattern", "query", "regex", "search"],
    argsKeys: ["include", "lang", "language"],
  },
  web: {
    icon: "globe",
    label: "Web",
    subtitleKeys: ["url", "query"],
    argsKeys: ["format", "categories"],
  },
  memory: {
    icon: "brain",
    label: "Memory",
    subtitleKeys: ["query", "title"],
  },
  note: {
    icon: "notebook-pen",
    label: "Note",
    subtitleKeys: ["title", "pattern"],
    argsKeys: ["scope", "mode"],
  },
  task: {
    icon: "list-todo",
    label: "Task",
    subtitleKeys: ["description", "prompt"],
  },
  dag: {
    icon: "route",
    label: "DAG",
    subtitleKeys: [],
  },
  schedule: {
    icon: "clipboard-check",
    label: "Schedule",
    subtitleKeys: ["title", "id"],
    argsKeys: ["status"],
  },
  session: {
    icon: "message-square",
    label: "Session",
    subtitleKeys: ["target", "pattern"],
    argsKeys: ["scope"],
  },
  "session-control": {
    icon: "radar",
    label: "Control",
    subtitleKeys: ["target"],
    argsKeys: ["action"],
  },
  community: {
    icon: "compass",
    label: "Agora",
    subtitleKeys: ["keyword", "post_id", "title", "comment"],
  },
  network: {
    icon: "cable",
    label: "Connect",
    subtitleKeys: ["envID"],
    argsKeys: ["action"],
  },
  analyze: {
    icon: "scan-eye",
    label: "Analyze",
    subtitleKeys: ["goal", "file_path", "description"],
  },
  config: {
    icon: "rotate-cw",
    label: "Config",
    subtitleKeys: ["target", "name", "reason"],
  },
  communication: {
    icon: "mail",
    label: "Send",
    subtitleKeys: ["to", "target", "subject"],
  },
  skill: {
    icon: "sparkles",
    label: "Skill",
    subtitleKeys: ["name"],
  },
  research: {
    icon: "flask-conical",
    label: "Research",
    subtitleKeys: ["action", "title", "project"],
    argsKeys: ["action"],
  },
  generic: {
    icon: "settings",
    label: "",
    subtitleKeys: [],
  },
}

// ── Flat tool name → category map ────────────────────────────────────

const TOOL_CATEGORIES: Record<string, SemanticCategory> = {
  // search
  websearch: "web",
  webfetch: "web",
  arxiv_search: "search",
  arxiv_download: "search",
  grep: "search",
  ast_grep: "search",
  glob: "search",
  session_search: "session",
  note_search: "note",
  memory_search: "memory",
  memory_get: "memory",

  // code
  read: "file-read",
  list: "file-read",
  look_at: "analyze",
  edit: "file-write",
  write: "file-write",
  bash: "shell",
  process: "shell",
  lsp: "analyze",

  // knowledge
  memory_write: "memory",
  memory_edit: "memory",
  note_write: "note",
  note_list: "note",
  note_read: "note",
  skill: "skill",

  // orchestration
  task: "task",
  task_list: "task",
  task_output: "task",
  task_cancel: "task",
  dagwrite: "dag",
  dagread: "dag",
  dagpatch: "dag",
  todowrite: "dag",
  todoread: "dag",
  session_list: "session",
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
  runtime_reload: "config",
  profile_get: "config",
  profile_update: "config",
  connect: "network",
  remote_session: "network",
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
  agora_search: "community",
  agora_read: "community",
  agora_post: "community",
  agora_join: "community",
  agora_sync: "community",
  agora_submit: "community",
  agora_accept: "community",
  agora_comment: "community",

  // communication
  question: "communication",
  email_send: "communication",
  email_read: "communication",
  diagram: "analyze",
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
// When a tool isn't in TOOL_CATEGORIES, infer category from name.
// Checked in order; first match wins.

const PATTERN_FALLBACKS: { pattern: RegExp; category: SemanticCategory }[] = [
  { pattern: /^(web)?search/i, category: "web" },
  { pattern: /^(web)?fetch/i, category: "web" },
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
  { pattern: /^(memory|engram|remember|recall)/i, category: "memory" },
  { pattern: /^note[-_]/i, category: "note" },
  { pattern: /^skill/i, category: "skill" },
  { pattern: /^(task|delegate|dispatch|spawn)/i, category: "task" },
  { pattern: /^(dag|plan)/i, category: "dag" },
  { pattern: /^todo/i, category: "dag" },
  { pattern: /^session[-_]/i, category: "session" },
  { pattern: /^(agenda|schedule|cron|timer|remind)/i, category: "schedule" },
  { pattern: /^research[-_]/i, category: "research" },
  { pattern: /^(config|setting|profile|runtime)/i, category: "config" },
  { pattern: /^inspire[-_]/i, category: "shell" },
  { pattern: /^agora[-_]/i, category: "community" },
  { pattern: /^(email|mail)/i, category: "communication" },
  { pattern: /^(send|notify|message)/i, category: "communication" },
  { pattern: /^question/i, category: "communication" },
  { pattern: /^diagram/i, category: "analyze" },
  { pattern: /^attach/i, category: "communication" },
]

// ── Input-shape heuristics ───────────────────────────────────────────

const INPUT_HEURISTICS: { keys: string[]; writeHint?: string[]; category: SemanticCategory }[] = [
  { keys: ["command", "cmd", "script"], category: "shell" },
  { keys: ["filePath", "file_path"], writeHint: ["content", "newString", "oldString", "diff"], category: "file-write" },
  { keys: ["filePath", "file_path", "path"], category: "file-read" },
  { keys: ["query", "pattern", "regex", "search"], category: "search" },
  { keys: ["url", "href", "endpoint"], category: "web" },
]

// ── Classifier ──────────────────────────────────────────────────────

export interface ClassifiedTool {
  category: SemanticCategory
  spec: CategorySpec
  title: string
  subtitle?: string
  args?: string[]
}

/**
 * Classify a tool call by its semantic category.
 *
 * Returns a structured result with icon, title, subtitle, and args
 * extracted from the tool name, input, and metadata.
 */
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

  const title = humanizeToolName(toolName, category, spec)

  const subtitle = extractField(metadata, spec.subtitleKeys) ?? extractField(input, spec.subtitleKeys)

  const args = buildArgs(input, metadata, spec)

  return { category, spec, title, subtitle, args }
}

/**
 * Turn a tool name into a human-readable title.
 *
 * Examples:
 *   "read_file" → "Read File"
 *   "execute_command" → "Execute Command"
 *   "bash" → "Shell"  (uses category label when it's more descriptive)
 *   "my_custom_tool" → "My Custom Tool"
 */
function humanizeToolName(name: string, category: SemanticCategory, spec: CategorySpec): string {
  // If the category has a label and the tool is a known short name,
  // prefer the label
  if (spec.label && TOOL_CATEGORIES[name]) {
    if (name.length <= 6) return spec.label
  }

  // Convert snake_case/camelCase/kebab-case to Title Case
  return name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Extract the first non-empty string value from input matching the key list.
 */
function extractField(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = input[key]
    if (typeof val === "string" && val.length > 0) return val
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") return val[0]
  }
  return undefined
}

/**
 * Build args badges from input + metadata.
 *
 * Merges three sources:
 * 1. Category-specific input keys (e.g. `scope`, `format`)
 * 2. Metadata count badges (e.g. `3 results`, `5 notes`)
 * 3. Metadata status/action labels (e.g. `Created`, `Connected`)
 */
function buildArgs(
  input: Record<string, any>,
  metadata: Record<string, any>,
  spec: CategorySpec,
): string[] | undefined {
  const args: string[] = []

  // From input args keys
  if (spec.argsKeys) {
    for (const k of spec.argsKeys) {
      const v = input[k]
      if (typeof v === "string" && v.length > 0) args.push(v)
    }
  }

  // Metadata count badge — many tools return { count: N } or { total: N }
  const count = metadata.count ?? metadata.total ?? metadata.matchCount
  if (typeof count === "number") {
    // Try to infer a unit from the tool context
    const unit =
      metadata.noteCount != null
        ? `${count} match${count === 1 ? "" : "es"} in ${metadata.noteCount} note${metadata.noteCount === 1 ? "" : "s"}`
        : inferCountUnit(count, spec)
    args.push(unit)
  }

  // Metadata status/action label
  const status = metadata.status ?? metadata.action
  if (typeof status === "string" && status.length > 0 && status.length < 20) {
    args.push(status.charAt(0).toUpperCase() + status.slice(1))
  }

  return args.length > 0 ? args : undefined
}

/**
 * Produce a count badge like "3 sessions" or "5 items".
 */
function inferCountUnit(count: number, spec: CategorySpec): string {
  const unitMap: Partial<Record<SemanticCategory, string>> = {
    session: "session",
    note: "note",
    memory: "result",
    search: "result",
    community: "post",
    schedule: "item",
    task: "task",
  }
  const unit = unitMap[spec.label.toLowerCase() as SemanticCategory] ?? "item"
  return `${count} ${unit}${count === 1 ? "" : "s"}`
}
