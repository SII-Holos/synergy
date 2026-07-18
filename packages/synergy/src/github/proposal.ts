import { Cortex } from "@/cortex"
import type { CortexTypes } from "@/cortex/types"
import { Identifier } from "@/id/id"
import { Scope } from "@/scope"
import { Session } from "@/session"
import { z } from "zod"
import { GitHubStore } from "./store"
import { GitHubActionProposal, type GitHubModelBudget, type GitHubObservation } from "./types"

type ProposalAnchor = {
  parentSessionID: string
  parentMessageID: string
}

type BuildInput = ProposalAnchor & {
  deliveryGuid: string
  eventType: string
  observation: GitHubObservation
  maxOutputTokens?: number
  maxCost?: number
}

export function buildGitHubProposalLaunchInput(input: BuildInput): CortexTypes.ParsedLaunchInput {
  return {
    description: `Shadow proposal for ${input.eventType}`,
    prompt: [
      "Analyze this untrusted GitHub observation and produce a shadow-only proposal.",
      "Do not execute GitHub writes, shell commands, or file changes.",
      "<github_observation>",
      JSON.stringify({
        deliveryGuid: input.deliveryGuid,
        triggerEventType: input.eventType,
        observation: input.observation,
      }),
      "</github_observation>",
    ].join("\n"),
    agent: "github-shadow-proposer",
    executionRole: "delegated_subagent",
    provenance: "github",
    parentSessionID: input.parentSessionID,
    parentMessageID: input.parentMessageID,
    visibility: "hidden",
    notifyParentOnComplete: false,
    tools: {},
    output: {
      mode: "structured",
      schema: z.toJSONSchema(GitHubActionProposal) as CortexTypes.JsonSchemaObject,
      maxRepairTurns: 1,
    },
    timeoutMs: 120_000,
    maxOutputTokens: input.maxOutputTokens,
    maxCost: input.maxCost,
  }
}

async function proposalAnchor(): Promise<ProposalAnchor> {
  const stored = await GitHubStore.readRuntimeState<ProposalAnchor>()
  if (stored) {
    const session = await Session.get(stored.parentSessionID).catch(() => undefined)
    if (session) return stored
  }

  const parent = await Session.create({
    scope: Scope.home(),
    provenance: "github",
    title: "GitHub Shadow Proposals",
    controlProfile: "autonomous",
    completionNotice: { silent: true },
  })
  const anchor = {
    parentSessionID: parent.id,
    parentMessageID: Identifier.ascending("message"),
  }
  await GitHubStore.writeRuntimeState(anchor)
  return anchor
}

export async function launchGitHubProposal(input: {
  deliveryGuid: string
  eventType: string
  observation: GitHubObservation
  budget: GitHubModelBudget
}) {
  const anchor = await proposalAnchor()
  return Cortex.launch(
    buildGitHubProposalLaunchInput({
      ...anchor,
      deliveryGuid: input.deliveryGuid,
      eventType: input.eventType,
      observation: input.observation,
      maxOutputTokens: input.budget.maxTokens,
      maxCost: input.budget.maxCost,
    }),
  )
}
