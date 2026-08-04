import { afterEach, describe, expect, mock, test } from "bun:test"
import { AgentCall } from "../../src/agent/call"
import { Session } from "../../src/session"
import { classifyGitHubObservation, parseGitHubClassification } from "../../src/github/classifier"
import type { GitHubModelBudget } from "../../src/github/types"

const originalAgentCall = AgentCall.text
const originalGetUsage = Session.getUsage

afterEach(() => {
  ;(AgentCall.text as any) = originalAgentCall
  ;(Session.getUsage as any) = originalGetUsage
})

describe("classifyGitHubObservation", () => {
  test("forwards integration provenance and measures the budget on the used model", async () => {
    const observation = {
      eventType: "issues.opened",
      repository: "owner/repo",
      title: "Crash on startup",
      body: "It crashes",
    }
    const budget: GitHubModelBudget = { maxTokens: 1_000, maxCost: 0.1 }
    const usedModel = { providerID: "provider", id: "model" } as any
    let received: AgentCall.TextInput | undefined
    ;(AgentCall.text as any) = mock(async (input: AgentCall.TextInput) => {
      received = input
      return {
        text: '{"relevant":true,"category":"bug","confidence":0.9,"reason":"crash"}',
        model: usedModel,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    })
    let measured: { model: unknown; usage: unknown } | undefined
    ;(Session.getUsage as any) = mock((input: { model: unknown; usage: unknown }) => {
      measured = input
      return { tokens: { output: 5 }, cost: 0.001 }
    })

    const result = await classifyGitHubObservation(observation, budget)

    expect(result).toEqual({ classification: { relevant: true, category: "bug", confidence: 0.9, reason: "crash" } })
    expect(received?.agent).toBe("github-shadow-classifier")
    expect(received?.userMetadata).toEqual({ source: "integration:github" })
    expect(received?.maxOutputTokens).toBe(1_000)
    expect(measured?.model).toBe(usedModel)
  })

  test("maps agent and model errors to stable skipped reasons", async () => {
    const observation = { eventType: "issues.opened", repository: "owner/repo" }
    const budget: GitHubModelBudget = { maxTokens: 1_000, maxCost: 0.1 }
    ;(AgentCall.text as any) = mock(async () => {
      throw new AgentCall.Error("agent_not_found", "unavailable")
    })
    expect(await classifyGitHubObservation(observation, budget)).toEqual({ skippedReason: "agent_unavailable" })
    ;(AgentCall.text as any) = mock(async () => {
      throw new AgentCall.Error("model_unavailable", "unavailable")
    })
    expect(await classifyGitHubObservation(observation, budget)).toEqual({ skippedReason: "model_unavailable" })
  })
})

describe("GitHub nano classifier output", () => {
  test("validates a bounded JSON decision", () => {
    expect(
      parseGitHubClassification('{"relevant":true,"category":"bug","confidence":0.92,"reason":"Reproducible crash"}'),
    ).toEqual({
      relevant: true,
      category: "bug",
      confidence: 0.92,
      reason: "Reproducible crash",
    })
  })

  test("fails soft on malformed, out-of-range, or unrelated output", () => {
    expect(parseGitHubClassification("not json")).toBeUndefined()
    expect(parseGitHubClassification('{"relevant":true,"category":"bug","confidence":2,"reason":"x"}')).toBeUndefined()
    expect(
      parseGitHubClassification('{"relevant":true,"category":"other","confidence":0.9,"reason":"x"}'),
    ).toBeUndefined()
  })
})
