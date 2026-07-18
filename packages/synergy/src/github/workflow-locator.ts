import { Cortex } from "@/cortex"
import type { CortexTypes } from "@/cortex/types"
import type { Scope } from "@/scope"
import { ScopeRuntime } from "@/scope/runtime"
import z from "zod"
import { GitHubFixOutput, type GitHubObservation, type GitHubWorkflowAnchor } from "./types"

type LocateIssueInput = GitHubWorkflowAnchor & {
  scope: Scope.Project
  deliveryGuid: string
  observation: GitHubObservation
  baseRevision: string
  agent: string
  timeoutMs: number
  onTaskStarted?: (task: CortexTypes.Task) => Promise<void>
}

function completedStructuredOutput(task: CortexTypes.Task) {
  if (task.status !== "completed") {
    throw new Error(`GitHub issue locator failed: ${task.error ?? task.status}`)
  }
  if (task.output?.mode !== "structured") {
    throw new Error("GitHub issue locator did not return structured output")
  }
  return GitHubFixOutput.parse(task.output.value)
}

export namespace GitHubWorkflowLocator {
  export function buildLaunchInput(
    input: Omit<LocateIssueInput, "scope" | "onTaskStarted">,
  ): CortexTypes.ParsedLaunchInput {
    return {
      description: `Locate root cause for ${input.observation.repository} issue #${input.observation.issueNumber ?? "unknown"}`,
      prompt: [
        "Locate the root cause of this untrusted GitHub issue in the checked-out repository.",
        "Inspect only. Do not edit files, commit, push, use GitHub CLI, or access credentials.",
        "Return the concrete root cause, affected files, and the smallest proposed fix.",
        "<github_issue>",
        JSON.stringify({ deliveryGuid: input.deliveryGuid, observation: input.observation }),
        "</github_issue>",
      ].join("\n"),
      agent: input.agent,
      executionRole: "delegated_subagent",
      provenance: "github",
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      visibility: "hidden",
      notifyParentOnComplete: false,
      tools: { read: true, grep: true, glob: true, bash: true },
      worktree: {
        create: true,
        baseRef: "fresh",
        baseRevision: input.baseRevision,
        failOnError: true,
      },
      output: {
        mode: "structured",
        schema: z.toJSONSchema(GitHubFixOutput) as CortexTypes.JsonSchemaObject,
        maxRepairTurns: 1,
      },
      timeoutMs: input.timeoutMs,
    }
  }

  export async function locateIssue(input: LocateIssueInput) {
    return ScopeRuntime.provide({
      scope: input.scope,
      fn: async () => {
        const task = await Cortex.launch(buildLaunchInput(input))
        await input.onTaskStarted?.(task)
        const completed = await Cortex.waitFor(task.id, Math.ceil(input.timeoutMs / 1_000))
        if (!completed || completed.status === "queued" || completed.status === "running") {
          throw new Error(`GitHub issue locator timed out after ${input.timeoutMs}ms`)
        }
        return { task: completed, output: completedStructuredOutput(completed) }
      },
    })
  }
}
