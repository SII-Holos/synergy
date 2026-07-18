import { Agent } from "@/agent/agent"
import { Identifier } from "@/id/id"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { LLM } from "@/session/llm"
import type { MessageV2 } from "@/session/message-v2"
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
    const agent = await Agent.get("github-shadow-classifier")
    if (!agent) return { skippedReason: "agent_unavailable" }
    const ref = await Agent.getAvailableModel(agent)
    if (!ref) return { skippedReason: "model_unavailable" }
    const model = await Provider.getModel(ref.providerID, ref.modelID)
    const sessionID = Identifier.ascending("session")
    const user: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
      metadata: { source: "integration:github" },
    }
    const result = await LLM.stream({
      agent,
      user,
      tools: {},
      model,
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
      abort: AbortSignal.timeout(10_000),
      sessionID,
      system: [],
      retries: 0,
      maxOutputTokens: budget.maxTokens,
    })
    const [text, usage] = await Promise.all([
      LLM.collectText(result).catch(() => ""),
      result.usage.catch(() => undefined),
    ])
    if (!usage) return { skippedReason: "usage_unavailable" }
    const measured = Session.getUsage({ model, usage })
    if (measured.tokens.output > budget.maxTokens || measured.cost > budget.maxCost) {
      return { skippedReason: "budget_exceeded" }
    }
    const classification = parseGitHubClassification(text)
    return classification ? { classification } : { skippedReason: "invalid_output" }
  } catch (error) {
    log.warn("classification failed", { error })
    return { skippedReason: "classifier_failed" }
  }
}
