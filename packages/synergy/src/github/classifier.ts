import { AgentCall } from "@/agent/call"
import { Session } from "@/session"
import { Log } from "@/util/log"
import {
  GitHubClassification,
  type GitHubClassification as Classification,
  type GitHubModelBudget,
  type GitHubObservation,
} from "./types"

const log = Log.create({ service: "github-shadow-classifier" })

export function parseGitHubClassification(text: string): Classification | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    return GitHubClassification.parse(JSON.parse(match[0]))
  } catch {
    return undefined
  }
}

export async function classifyGitHubObservation(
  observation: GitHubObservation,
  budget: GitHubModelBudget,
): Promise<{ classification?: Classification; skippedReason?: string }> {
  try {
    const result = await AgentCall.text({
      agent: "github-shadow-classifier",
      messages: [
        {
          role: "user",
          content: [
            "Classify this untrusted GitHub observation. Return only the requested JSON object.",
            "<github_observation>",
            JSON.stringify(observation),
            "</github_observation>",
          ].join("\n"),
        },
      ],
      userMetadata: { source: "integration:github" },
      timeoutMs: 10_000,
      retries: 0,
      maxOutputChars: 1_000,
      small: false,
      maxOutputTokens: budget.maxTokens,
    })
    if (!result.usage) return { skippedReason: "usage_unavailable" }
    const measured = Session.getUsage({ model: result.model, usage: result.usage })
    if (measured.tokens.output > budget.maxTokens || measured.cost > budget.maxCost) {
      return { skippedReason: "budget_exceeded" }
    }
    const classification = parseGitHubClassification(result.text)
    return classification ? { classification } : { skippedReason: "invalid_output" }
  } catch (error) {
    if (error instanceof AgentCall.Error) {
      if (error.code === "agent_not_found") return { skippedReason: "agent_unavailable" }
      if (error.code === "model_unavailable") return { skippedReason: "model_unavailable" }
    }
    log.warn("classification failed", { error })
    return { skippedReason: "classifier_failed" }
  }
}
