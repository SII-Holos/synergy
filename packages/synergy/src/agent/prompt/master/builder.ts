import PROMPT_BASE from "./base.txt"
import {
  buildInteractiveMemorySection,
  INTERACTIVE_MEMORY_BOUNDARY_COMMON,
  INTERACTIVE_MEMORY_METHOD_COMMON,
  INTERACTIVE_MEMORY_PRIORITY_COMMON,
} from "../interactive-memory"

export function buildMasterPrompt(): string {
  const memorySection = buildInteractiveMemorySection({
    intro: "During user-facing work, treat memory as an active collaboration tool, not as a passive afterthought.",
    boundary: [
      ...INTERACTIVE_MEMORY_BOUNDARY_COMMON,
      "Execution speed never overrides authorization boundaries, especially when coding work spills into outbound messages, tickets, deployments, or user-identity actions",
    ],
    priority: [
      ...INTERACTIVE_MEMORY_PRIORITY_COMMON,
      "Durable project constraints, release rules, deployment guardrails, or approval gates that repeatedly affect implementation work",
    ],
    search: [
      "Before making assumptions about the user's established coding preferences, collaboration style, or recurring project constraints",
      'When the user refers to prior decisions, prior conversations, or "the usual way we do this"',
      "When you are entering a familiar codebase or recurring problem domain and past context could change your implementation choices",
      "When you suspect a relevant memory exists but was not auto-injected",
    ],
    edit: [
      "When this session clearly corrects, refines, or supersedes an existing memory",
      "When the user gives a sharper version of an existing preference or constraint",
      "When an existing memory is directionally right but classified with the wrong `category` or `recallMode`",
    ],
    write: [
      "When the user establishes a durable coding preference, workflow rule, or collaboration constraint that should affect future sessions",
      "When you learn a durable project convention or technical lesson that is not easy to recover from code, docs, or git history alone",
      "When you explicitly tell the user you will remember a rule or preference and the session has established it clearly",
    ],
    avoid: [
      "Temporary task state, in-progress plans, or one-off debugging steps",
      "Facts already obvious from the final code, tests, docs, or commit history",
      "Low-confidence hunches that have not been clearly established",
    ],
    method: [
      ...INTERACTIVE_MEMORY_METHOD_COMMON,
      "Use `workflow`, `coding`, `interaction`, `relationship`, or `knowledge` deliberately based on what was learned",
      "If coding work leads to an outbound action such as messaging, deployment coordination, or acting through the user's identity, checkpoint before the external step",
    ],
  })

  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", memorySection)
}
