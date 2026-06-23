/**
 * Canonical tool taxonomy — the single source of truth for tool classification.
 *
 * Two-level hierarchy:
 *   domain  — broad functional area, derived from the kind prefix
 *   kind    — specific tool behavior (e.g. "search.web", "code.read")
 *
 * Behavioral traits (orthogonal to classification):
 *   auxiliary   — supporting action that doesn't constitute a primary work phase
 *   stateful    — modifies persistent state
 *   externalIO  — reaches outside the local environment
 *
 * Consumers:
 *   - cortex/trajectory.ts  — domain for phase grouping, kind for labels
 *   - ui/tool/classifier.ts — kind→SemanticCategory mapping
 */

// ── Types ────────────────────────────────────────────────────────────

export type ToolDomain = "search" | "code" | "knowledge" | "orchestration" | "platform" | "communication" | "browser"

export type ToolKind =
  | "search.web"
  | "search.academic"
  | "search.codebase"
  | "search.session"
  | "search.note"
  | "search.memory"
  | "code.read"
  | "code.write"
  | "code.execute"
  | "code.analyze"
  | "knowledge.memory"
  | "knowledge.note"
  | "knowledge.skill"
  | "knowledge.wiki"
  | "orchestration.task"
  | "orchestration.dag"
  | "orchestration.todo"
  | "orchestration.session"
  | "orchestration.session_control"
  | "orchestration.agenda"
  | "orchestration.research"
  | "platform.config"
  | "platform.compute"
  | "platform.collaboration"
  | "platform.external"
  | "communication.question"
  | "communication.email"
  | "communication.visual"
  | "communication.deliver"
  | "browser.navigate"
  | "browser.interact"
  | "browser.inspect"
  | "browser.tab"
  | "browser.download"
  | "browser.annotate"

export interface ToolTraits {
  auxiliary?: true
  stateful?: true
  externalIO?: true
}

export interface ToolTaxonomyEntry {
  kind: ToolKind
  domain: ToolDomain
  traits: ToolTraits
}

// ── Helpers ──────────────────────────────────────────────────────────

function domainOf(kind: ToolKind): ToolDomain {
  return kind.split(".")[0] as ToolDomain
}

function entry(kind: ToolKind, traits: ToolTraits = {}): ToolTaxonomyEntry {
  return { kind, domain: domainOf(kind), traits }
}

// ── Registry ─────────────────────────────────────────────────────────

const REGISTRY: Record<string, ToolTaxonomyEntry> = {
  // search
  websearch: entry("search.web", { externalIO: true }),
  webfetch: entry("search.web", { externalIO: true }),
  arxiv_search: entry("search.academic", { externalIO: true }),
  arxiv_download: entry("search.academic", { externalIO: true }),
  grep: entry("search.codebase"),
  scan_files: entry("search.codebase"),
  ast_grep: entry("search.codebase"),
  parse_code: entry("code.analyze"),
  glob: entry("search.codebase"),
  session_search: entry("search.session"),
  note_search: entry("search.note"),
  memory_search: entry("search.memory"),
  memory_get: entry("search.memory"),

  // code
  read: entry("code.read"),
  view_file: entry("code.read"),
  list: entry("code.read"),
  look_at: entry("code.analyze"),
  scan_document: entry("code.analyze"),
  edit: entry("code.write", { stateful: true }),
  revise_file: entry("code.write", { stateful: true }),
  write: entry("code.write", { stateful: true }),
  save_file: entry("code.write", { stateful: true }),
  bash: entry("code.execute"),
  process: entry("code.execute"),
  lsp: entry("code.analyze"),

  // knowledge
  memory_write: entry("knowledge.memory", { stateful: true, auxiliary: true }),
  memory_edit: entry("knowledge.memory", { stateful: true, auxiliary: true }),
  note_write: entry("knowledge.note", { stateful: true, auxiliary: true }),
  note_edit: entry("knowledge.note", { stateful: true, auxiliary: true }),
  note_list: entry("knowledge.note"),
  note_read: entry("knowledge.note"),
  blueprint_list: entry("knowledge.note"),
  blueprint_read: entry("knowledge.note"),
  blueprint_create: entry("knowledge.note", { stateful: true, auxiliary: true }),
  blueprint_write: entry("knowledge.note", { stateful: true, auxiliary: true }),
  blueprint_duplicate: entry("knowledge.note", { stateful: true, auxiliary: true }),
  blueprint_loop_finish: entry("orchestration.task", { stateful: true }),
  blueprint_loop_restart: entry("orchestration.task", { stateful: true }),
  skill: entry("knowledge.skill"),

  // orchestration
  task: entry("orchestration.task"),
  task_list: entry("orchestration.task"),
  task_output: entry("orchestration.task"),
  task_cancel: entry("orchestration.task"),
  dagwrite: entry("orchestration.dag", { stateful: true, auxiliary: true }),
  dagread: entry("orchestration.dag", { auxiliary: true }),
  dagpatch: entry("orchestration.dag", { stateful: true, auxiliary: true }),
  todowrite: entry("orchestration.todo", { stateful: true, auxiliary: true }),
  todoread: entry("orchestration.todo", { auxiliary: true }),
  session_list: entry("orchestration.session"),
  session_read: entry("orchestration.session"),
  session_send: entry("orchestration.session", { stateful: true }),
  session_control: entry("orchestration.session_control", { stateful: true }),
  agenda_schedule: entry("orchestration.agenda", { stateful: true }),
  agenda_watch: entry("orchestration.agenda", { stateful: true }),
  agenda_list: entry("orchestration.agenda"),
  agenda_update: entry("orchestration.agenda", { stateful: true }),
  agenda_cancel: entry("orchestration.agenda", { stateful: true }),
  agenda_trigger: entry("orchestration.agenda", { stateful: true }),
  agenda_logs: entry("orchestration.agenda"),
  research_init: entry("orchestration.research", { stateful: true }),
  research_state: entry("orchestration.research", { stateful: true }),
  research_idea: entry("orchestration.research", { stateful: true }),
  research_plan: entry("orchestration.research", { stateful: true }),
  research_experiment: entry("orchestration.research", { stateful: true }),
  research_claim: entry("orchestration.research", { stateful: true }),
  research_exhibit: entry("orchestration.research", { stateful: true }),
  research_paper: entry("orchestration.research", { stateful: true }),
  research_submission: entry("orchestration.research", { stateful: true }),
  research_wiki: entry("knowledge.wiki", { stateful: true }),
  research_timeline: entry("orchestration.research"),

  // platform
  runtime_reload: entry("platform.config", { stateful: true }),
  worktree_enter: entry("platform.config", { stateful: true }),
  worktree_leave: entry("platform.config", { stateful: true }),
  worktree_list: entry("platform.config"),

  connect: entry("platform.config"),
  inspire_status: entry("platform.compute", { externalIO: true }),
  inspire_config: entry("platform.compute"),
  inspire_login: entry("platform.compute", { stateful: true, externalIO: true }),
  inspire_submit: entry("platform.compute", { stateful: true, externalIO: true }),
  inspire_submit_hpc: entry("platform.compute", { stateful: true, externalIO: true }),
  inspire_jobs: entry("platform.compute", { externalIO: true }),
  inspire_job_detail: entry("platform.compute", { externalIO: true }),
  inspire_logs: entry("platform.compute", { externalIO: true }),
  inspire_metrics: entry("platform.compute", { externalIO: true }),
  inspire_stop: entry("platform.compute", { stateful: true, externalIO: true }),
  inspire_images: entry("platform.compute", { externalIO: true }),
  inspire_image_push: entry("platform.compute", { stateful: true, externalIO: true }),
  inspire_notebook: entry("platform.compute", { stateful: true, externalIO: true }),
  inspire_models: entry("platform.compute", { externalIO: true }),
  inspire_inference: entry("platform.compute", { stateful: true, externalIO: true }),
  //   agora_search: entry("platform.collaboration"),
  //   agora_read: entry("platform.collaboration"),
  //   agora_post: entry("platform.collaboration", { stateful: true }),
  //   agora_join: entry("platform.collaboration", { stateful: true }),
  //   agora_sync: entry("platform.collaboration", { stateful: true }),
  //   agora_submit: entry("platform.collaboration", { stateful: true }),
  //   agora_accept: entry("platform.collaboration", { stateful: true }),
  //   agora_comment: entry("platform.collaboration", { stateful: true }),

  // communication
  question: entry("communication.question"),
  email_send: entry("communication.email", { stateful: true, externalIO: true }),
  email_read: entry("communication.email", { externalIO: true }),
  // 🔇 diagram: entry("communication.visual"),  — 已注释，待重构
  render: entry("communication.visual"),
  attach: entry("communication.deliver"),
  // browser
  browser_navigate: entry("browser.navigate", { externalIO: true, stateful: true }),
  browser_snapshot: entry("browser.inspect"),
  browser_screenshot: entry("browser.inspect", { stateful: true }),
  browser_inspect: entry("browser.inspect"),
  browser_wait: entry("browser.inspect"),
  browser_click: entry("browser.interact", { stateful: true }),
  browser_type: entry("browser.interact", { stateful: true }),
  browser_scroll: entry("browser.interact", { stateful: true }),
  browser_action: entry("browser.interact", { stateful: true }),
  browser_tab: entry("browser.tab", { stateful: true }),
  browser_console: entry("browser.inspect"),
  browser_network: entry("browser.inspect"),
  browser_download: entry("browser.download", { externalIO: true }),
  browser_downloads: entry("browser.download", { stateful: true }),
  browser_viewport: entry("browser.inspect", { stateful: true }),
  browser_annotate: entry("browser.annotate", { stateful: true }),
  browser_read: entry("browser.inspect"),
  browser_eval: entry("browser.inspect", { stateful: true }),
  browser_clipboard: entry("browser.interact", { externalIO: true }),
  browser_list: entry("browser.inspect"),
  browser_assets: entry("browser.inspect"),
  browser_view: entry("browser.inspect"),
  browser_navigation: entry("browser.navigate", { stateful: true }),
}

// ── Pattern fallbacks ────────────────────────────────────────────────

const PATTERN_FALLBACKS: { pattern: RegExp; kind: ToolKind; traits?: ToolTraits }[] = [
  { pattern: /^(web)?search/i, kind: "search.web", traits: { externalIO: true } },
  { pattern: /^(web)?fetch/i, kind: "search.web", traits: { externalIO: true } },
  { pattern: /^arxiv/i, kind: "search.academic", traits: { externalIO: true } },
  {
    pattern: /^(grep|glob|find|ripgrep|rg|search[-_]?files?|codebase[-_]?search|file[-_]?search)/i,
    kind: "search.codebase",
  },
  { pattern: /^(read|get|load|fetch|cat|view|head|tail)[-_]?file/i, kind: "code.read" },
  { pattern: /^(list|ls|dir)[-_]?(dir|files?|folder)?$/i, kind: "code.read" },
  {
    pattern: /^(write|create|edit|update|patch|modify|replace|insert|append)[-_]?file/i,
    kind: "code.write",
    traits: { stateful: true },
  },
  { pattern: /^(apply[-_]?diff|save[-_]?file)/i, kind: "code.write", traits: { stateful: true } },
  { pattern: /^(run|exec|execute|shell|bash|sh|cmd|terminal|command)/i, kind: "code.execute" },
  { pattern: /[-_](command|exec|shell|terminal)$/i, kind: "code.execute" },
  { pattern: /^(look|analyze|vision|describe|inspect|examine)/i, kind: "code.analyze" },
  { pattern: /^(memory|engram|remember|recall)/i, kind: "knowledge.memory" },
  { pattern: /^note[-_]/i, kind: "knowledge.note" },
  { pattern: /^skill/i, kind: "knowledge.skill" },
  { pattern: /^(task|delegate|dispatch|spawn)/i, kind: "orchestration.task" },
  { pattern: /^(dag|plan)/i, kind: "orchestration.dag" },
  { pattern: /^todo/i, kind: "orchestration.todo" },
  { pattern: /^session[-_]/i, kind: "orchestration.session" },
  { pattern: /^(agenda|schedule|cron|timer|remind)/i, kind: "orchestration.agenda" },
  { pattern: /^research[-_]/i, kind: "orchestration.research" },
  { pattern: /^(config|setting|profile|runtime)/i, kind: "platform.config" },
  { pattern: /^inspire[-_]/i, kind: "platform.compute", traits: { externalIO: true } },
  //   { pattern: /^agora[-_]/i, kind: "platform.collaboration" },
  { pattern: /^(email|mail)/i, kind: "communication.email", traits: { externalIO: true } },
  { pattern: /^(send|notify|message)/i, kind: "communication.deliver" },
  { pattern: /^question/i, kind: "communication.question" },
  // 🔇 { pattern: /^diagram/i, kind: "communication.visual" },  — 已注释，待重构
  { pattern: /^render/i, kind: "communication.visual" },
  { pattern: /^attach/i, kind: "communication.deliver" },
  { pattern: /^browser_/i, kind: "browser.inspect" },
]

// ── Public API ───────────────────────────────────────────────────────

export namespace ToolTaxonomy {
  const DEFAULT_ENTRY: ToolTaxonomyEntry = entry("platform.external")

  export function classify(toolName: string): ToolTaxonomyEntry {
    const exact = REGISTRY[toolName]
    if (exact) return exact

    for (const rule of PATTERN_FALLBACKS) {
      if (rule.pattern.test(toolName)) {
        return entry(rule.kind, rule.traits)
      }
    }

    return DEFAULT_ENTRY
  }

  export function isAuxiliary(toolName: string): boolean {
    return classify(toolName).traits.auxiliary === true
  }

  export function register(toolName: string, entry: ToolTaxonomyEntry): void {
    REGISTRY[toolName] = entry
  }

  export const KIND_LABELS: Record<ToolKind, string> = {
    "search.web": "Web Search",
    "search.academic": "Academic Search",
    "search.codebase": "Code Search",
    "search.session": "Session Search",
    "search.note": "Note Search",
    "search.memory": "Memory Search",
    "code.read": "Read",
    "code.write": "Write",
    "code.execute": "Shell",
    "code.analyze": "Analyze",
    "knowledge.memory": "Memory",
    "knowledge.note": "Note",
    "knowledge.skill": "Skill",
    "knowledge.wiki": "Wiki",
    "orchestration.task": "Task",
    "orchestration.dag": "DAG",
    "orchestration.todo": "Todo",
    "orchestration.session": "Session",
    "orchestration.session_control": "Control",
    "orchestration.agenda": "Schedule",
    "orchestration.research": "Research",
    "platform.config": "Config",
    "platform.compute": "Compute",
    "platform.collaboration": "Agora",
    "platform.external": "Tool",
    "communication.question": "Ask",
    "communication.email": "Email",
    "communication.visual": "Diagram",
    "communication.deliver": "Deliver",
    "browser.navigate": "Navigate",
    "browser.interact": "Interact",
    "browser.inspect": "Inspect",
    "browser.tab": "Tabs",
    "browser.download": "Download",
    "browser.annotate": "Annotate",
  }
}
