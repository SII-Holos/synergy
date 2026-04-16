export interface InteractiveMemorySectionSpec {
  intro: string
  search: string[]
  edit: string[]
  write: string[]
  avoid: string[]
  method: string[]
  boundary?: string[]
  priority?: string[]
}

function renderBulletList(lines: string[]): string[] {
  return lines.map((line) => `- ${line}`)
}

export function buildInteractiveMemorySection(spec: InteractiveMemorySectionSpec): string {
  return [
    "## Memory Interaction",
    "",
    spec.intro,
    ...(spec.boundary?.length ? ["", "Boundary rules:", ...renderBulletList(spec.boundary)] : []),
    ...(spec.priority?.length ? ["", "High-priority memory candidates:", ...renderBulletList(spec.priority)] : []),
    "",
    "When to `memory_search`:",
    ...renderBulletList(spec.search),
    "",
    "When to `memory_edit`:",
    ...renderBulletList(spec.edit),
    "",
    "When to `memory_write`:",
    ...renderBulletList(spec.write),
    "",
    "What not to store:",
    ...renderBulletList(spec.avoid),
    "",
    "Working method:",
    ...renderBulletList(spec.method),
  ].join("\n")
}

export const INTERACTIVE_MEMORY_METHOD_COMMON = [
  "Search before writing when practical",
  "Prefer `memory_edit` over near-duplicate writes",
  "Choose `category` and `recallMode` deliberately rather than defaulting mechanically",
  "Reserve `always` for durable identity, default-language, interaction, or trust-boundary rules that should shape most sessions; most other memories should be `contextual` or `search_only`",
  "If persistence fails or tools are unavailable, do not pretend the memory was saved",
]

export const INTERACTIVE_MEMORY_ALWAYS_CANDIDATES_COMMON = [
  "The user's name and basic identity when they should matter in most future sessions",
  "The agent's own stable name, role, or core operating commitments",
  "The default language for working together",
  "Conversation-wide naming, tone, or interaction rules",
  "Durable consent, authorization, privacy, or representation boundaries that should govern most sessions",
]

export const INTERACTIVE_MEMORY_BOUNDARY_COMMON = [
  "Do not treat general task help as permission to speak, send, post, or decide on the user's behalf",
  "If an action would reach another person or system in the user's name, identity, or implied voice, require explicit approval first",
  "Preparing a draft or proposed message is not the same as sending it; checkpoint before the external action",
]

export const INTERACTIVE_MEMORY_PRIORITY_COMMON = [
  "User corrections about consent, authorization, privacy, identity, or external-action boundaries",
  "Durable collaboration rules that prevent repeated mistakes or trust erosion",
  "Clear statements such as 'remember this rule' or 'do not do this again' when they establish a lasting expectation",
  "Stable defaults that should shape most sessions rather than only a narrow task context",
]
