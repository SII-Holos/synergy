import type { IconName } from "./icon"

/**
 * Semantic tool classification system.
 *
 * Instead of hardcoding every tool name in a giant switch/case, we classify
 * tools by what they *do* — read files, execute commands, search, etc.
 *
 * The pipeline:
 *   1. Exact name match against registered patterns (cheap, covers 95% of known tools)
 *   2. Regex pattern matching against the tool name
 *   3. Input field heuristics (if input has `filePath` + `content` → probably a write)
 *   4. Fallback to "generic"
 *
 * This means external agent tools (codex shell, cline execute_command, gemini read_file)
 * automatically get reasonable icons and subtitle extraction — zero new code needed.
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
  | "community"
  | "network"
  | "analyze"
  | "config"
  | "communication"
  | "skill"
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
    icon: "pen-line",
    label: "Write",
    subtitleKeys: ["filePath", "file_path", "path", "filename"],
  },
  shell: {
    icon: "terminal",
    label: "Shell",
    subtitleKeys: ["description", "command", "cmd", "script"],
  },
  search: {
    icon: "search",
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
    icon: "git-branch",
    label: "DAG",
    subtitleKeys: [],
  },
  schedule: {
    icon: "calendar-days",
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
    icon: "eye",
    label: "Analyze",
    subtitleKeys: ["goal", "file_path", "description"],
  },
  config: {
    icon: "settings",
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
  generic: {
    icon: "settings",
    label: "",
    subtitleKeys: [],
  },
}

// ── Layer 1: Exact name → category ──────────────────────────────────
// Covers all known Synergy native tools and common external tool names.
// Cheap O(1) lookup.

const EXACT_MAP: Record<string, SemanticCategory> = {
  // file-read
  read: "file-read",
  list: "file-read",
  cat: "file-read",
  head: "file-read",
  tail: "file-read",
  read_file: "file-read",
  ReadFile: "file-read",
  readFile: "file-read",
  list_dir: "file-read",
  list_directory: "file-read",

  // file-write
  edit: "file-write",
  multiedit: "file-write",
  write: "file-write",
  patch: "file-write",
  write_file: "file-write",
  WriteFile: "file-write",
  writeFile: "file-write",
  create_file: "file-write",
  insert_content: "file-write",
  replace_in_file: "file-write",
  apply_diff: "file-write",
  editFile: "file-write",

  // shell
  bash: "shell",
  shell: "shell",
  process: "shell",
  execute_command: "shell",
  run_command: "shell",
  exec: "shell",
  terminal: "shell",
  run_terminal_command: "shell",
  executeCommand: "shell",

  // search
  grep: "search",
  glob: "search",
  ast_grep: "search",
  find: "search",
  ripgrep: "search",
  search_files: "search",
  codebase_search: "search",
  file_search: "search",

  // web
  websearch: "web",
  webfetch: "web",
  fetch: "web",
  browse: "web",
  curl: "web",
  browser_action: "web",

  // memory
  memory_search: "memory",
  memory_get: "memory",
  memory_write: "memory",
  memory_edit: "memory",

  // note
  note_list: "note",
  note_read: "note",
  note_search: "note",
  note_write: "note",

  // task
  task: "task",
  task_list: "task",
  task_output: "task",
  task_cancel: "task",

  // dag
  dagwrite: "dag",
  dagread: "dag",
  dagpatch: "dag",
  todowrite: "dag",
  todoread: "dag",

  // schedule
  agenda_create: "schedule",
  agenda_list: "schedule",
  agenda_update: "schedule",
  agenda_delete: "schedule",
  agenda_trigger: "schedule",
  agenda_logs: "schedule",

  // session
  session_list: "session",
  session_read: "session",
  session_search: "session",
  session_send: "session",

  // community
  agora_search: "community",
  agora_read: "community",
  agora_post: "community",
  agora_join: "community",
  agora_sync: "community",
  agora_submit: "community",
  agora_accept: "community",
  agora_comment: "community",

  // network
  connect: "network",
  remote_session: "network",

  // analyze
  look_at: "analyze",
  analyze: "analyze",
  vision: "analyze",

  // config
  runtime_reload: "config",
  profile_get: "config",
  profile_update: "config",

  // communication
  email: "communication",
  send_message: "communication",

  // skill
  skill: "skill",

  // web (more specific tools)
  question: "communication",
  diagram: "analyze",
  attach: "communication",

  // arXiv
  arxiv_search: "search",
  arxiv_download: "file-read",

  // context7 / MCP common
  "context7_resolve-library-id": "search",
  "context7_query-docs": "search",

  // lsp
  lsp: "analyze",
}

// ── Layer 2: Regex pattern → category ───────────────────────────────
// For tools that follow naming conventions across different agents.
// Checked in order; first match wins.

const PATTERN_RULES: { pattern: RegExp; category: SemanticCategory }[] = [
  // file operations
  { pattern: /^(read|get|load|fetch|cat|view)[-_]?file/i, category: "file-read" },
  { pattern: /^(list|ls|dir)[-_]?(dir|files|folder)?$/i, category: "file-read" },
  { pattern: /^(write|create|edit|update|patch|modify|replace|insert|append)[-_]?file/i, category: "file-write" },
  { pattern: /^(apply[-_]?diff|save[-_]?file)/i, category: "file-write" },

  // shell / execution
  { pattern: /^(run|exec|execute|shell|bash|sh|cmd|terminal|command)/i, category: "shell" },
  { pattern: /[-_](command|exec|shell|terminal)$/i, category: "shell" },

  // search
  { pattern: /^(search|find|grep|glob|rg|ripgrep|lookup)/i, category: "search" },
  { pattern: /(search|find|query)[-_]?(files?|code|text)?$/i, category: "search" },

  // web
  { pattern: /^(web|http|fetch|browse|curl|download)/i, category: "web" },
  { pattern: /[-_](url|web|http|fetch|browse)$/i, category: "web" },

  // memory
  { pattern: /^(memory|engram|remember|recall|forget)/i, category: "memory" },

  // note
  { pattern: /^note[-_]/i, category: "note" },

  // task / delegation
  { pattern: /^(task|delegate|dispatch|spawn)/i, category: "task" },

  // dag / plan
  { pattern: /^(dag|plan|todo)/i, category: "dag" },

  // schedule
  { pattern: /^(agenda|schedule|cron|timer|remind)/i, category: "schedule" },

  // session
  { pattern: /^session[-_]/i, category: "session" },

  // community
  { pattern: /^agora[-_]/i, category: "community" },

  // analyze / vision
  { pattern: /^(look|analyze|vision|describe|inspect|examine)/i, category: "analyze" },

  // config
  { pattern: /^(config|setting|profile|runtime)/i, category: "config" },

  // communication
  { pattern: /^(email|mail|send|notify|message)/i, category: "communication" },
]

// ── Layer 3: Input heuristic → category ─────────────────────────────
// When name-based matching fails, inspect the input shape.

const INPUT_HEURISTICS: { keys: string[]; writeHint?: string[]; category: SemanticCategory }[] = [
  // If input has a command/cmd field → shell
  { keys: ["command", "cmd", "script"], category: "shell" },
  // If input has file path + content/newString → write
  { keys: ["filePath", "file_path"], writeHint: ["content", "newString", "oldString", "diff"], category: "file-write" },
  // If input has file path alone → read
  { keys: ["filePath", "file_path", "path"], category: "file-read" },
  // If input has query/pattern → search
  { keys: ["query", "pattern", "regex", "search"], category: "search" },
  // If input has url → web
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
  // Layer 1: exact name
  let category = EXACT_MAP[toolName]

  // Layer 2: pattern match
  if (!category) {
    for (const rule of PATTERN_RULES) {
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
        if (hasWriteHint) {
          category = rule.category
          break
        }
        // Has file path but no write-specific fields → could be read
        category = "file-read"
        break
      }
      category = rule.category
      break
    }
  }

  // Fallback
  if (!category) category = "generic"

  const spec = CATEGORIES[category]

  // Extract title — humanize the tool name
  const title = humanizeToolName(toolName, spec)

  // Extract subtitle from metadata first (often has richer info), then input
  const subtitle = extractField(metadata, spec.subtitleKeys) ?? extractField(input, spec.subtitleKeys)

  // Build args: explicit category args + metadata-derived badges
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
function humanizeToolName(name: string, spec: CategorySpec): string {
  // If the category has a label and the name is a single word that matches
  // a well-known tool, prefer the label
  if (spec.label && EXACT_MAP[name]) {
    // For tools with very short names, use the category label
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
    // Capitalize first letter
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
