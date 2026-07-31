import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Session } from "@/session"
import type { ChannelHost } from "@/channel/host"
import type { RuntimeTaskAssignedEvent } from "./agent-tunnel-port"
import { ClarusAssignmentPrompt } from "./assignment-prompt"
import { ClarusAssignmentStore, type ClarusAssignment } from "./assignment-store"
import { ClarusDeadlineAgenda } from "./deadline-agenda"
import { preflightClarusAssignment } from "./assignment-preflight"
import type { ClarusCliRunner } from "./cli-runner"

function hash(...parts: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of parts) {
    hasher.update(part)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

export const ClarusAssignmentExpiredError = NamedError.create(
  "ClarusAssignmentExpiredError",
  z.object({ deadlineAt: z.string() }),
)

export const ClarusAssignmentSessionArchivedError = NamedError.create(
  "ClarusAssignmentSessionArchivedError",
  z.object({ sessionID: z.string() }),
)

export namespace ClarusAssignmentRuntime {
  export async function dispatch(input: {
    host: ChannelHost.Instance
    accountId: string
    event: RuntimeTaskAssignedEvent
    agentOverride?: string
    cliRunner?: ClarusCliRunner
  }): Promise<{ assignment: ClarusAssignment; created: boolean }> {
    const deadlineAt = input.event.deadlineAt
    if (deadlineAt) {
      const deadline = Date.parse(deadlineAt)
      if (Number.isFinite(deadline) && deadline <= Date.now()) {
        throw new ClarusAssignmentExpiredError({ deadlineAt })
      }
    }
    const existing = await ClarusAssignmentStore.findByIdentity({
      accountId: input.accountId,
      projectID: input.event.projectID,
      taskID: input.event.taskID,
    })
    const title = ClarusAssignmentPrompt.title(input.event)
    const basePrompt = ClarusAssignmentPrompt.userPrompt(input.accountId, input.event)
    const deliveryIdentity = hash(
      input.accountId,
      input.event.projectID,
      input.event.taskID,
      input.event.runID,
      input.event.subtaskID,
      String(input.event.attempt),
    )
    let assignment: ClarusAssignment | undefined
    const result = await input.host.tasks
      .dispatch({
        externalProjectId: input.event.projectID,
        externalTaskId: input.event.taskID,
        deliveryKey: `clarus-assignment:${deliveryIdentity}`,
        title,
        text: basePrompt,
        agent: input.agentOverride,
        retryOfTaskID: input.event.retryOfTaskID,
        boundSessionID: existing?.assignment.sessionID,
        systemGuidance: {
          deliveryKey: `clarus-participation:${deliveryIdentity}`,
          text: ClarusAssignmentPrompt.participationGuidance(input.event),
        },
        prepare: async ({ scope }) => {
          const preflight = await preflightClarusAssignment({ event: input.event, scope, runner: input.cliRunner })
          return { text: preflight.promptSection ? `${basePrompt}\n\n${preflight.promptSection}` : basePrompt }
        },
        beforeWake: async ({ sessionID }) => {
          assignment = (
            await ClarusAssignmentStore.upsert({
              accountId: input.accountId,
              event: input.event,
              sessionID,
              title,
            })
          ).assignment
          await ClarusDeadlineAgenda.sync({
            accountId: input.accountId,
            projectID: input.event.projectID,
            taskID: input.event.taskID,
            sessionID,
            deadlineAt: input.event.deadlineAt,
            active: assignment.status === "running" && assignment.resultState !== "acknowledged",
          })
        },
      })
      .catch((error) => {
        if (Session.EndpointSessionArchivedError.isInstance(error)) {
          throw new ClarusAssignmentSessionArchivedError({ sessionID: error.data.sessionID })
        }
        throw error
      })
    if (!assignment) throw new Error("Clarus assignment state was not persisted before task activation")
    return { assignment, created: result.deliveryCreated }
  }
}
