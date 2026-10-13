import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const contributions: readonly AgentPromptContributions.Contribution[] = [
  {
    requiredTools: ["render"],
    render: () =>
      "Use render for an inline HTML, SVG, table or chart when a visual helps explain the result. Keep it focused on the user's task.",
  },
  {
    requiredTools: ["scan_document"],
    render: () =>
      "Use scan_document for supported PDF, office, structured and archive documents. Its description defines the supported formats and extraction limits.",
  },
  {
    requiredTools: ["look_at"],
    render: () =>
      "Use look_at when separate vision-model analysis is needed. If view_image is available, it can instead load an image directly into the current model context.",
  },
]

export function registerMediaPrompts() {
  AgentPromptContributions.register("media", contributions)
}
