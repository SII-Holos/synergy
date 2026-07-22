import type { ChannelHost } from "@/channel/host"
import type { RuntimeTaskAssignedEvent } from "./agent-tunnel-port"
import { ClarusAssignmentPrompt } from "./assignment-prompt"
import { ClarusAssignmentStore, type ClarusAssignment } from "./assignment-store"
import { ClarusDeadlineAgenda } from "./deadline-agenda"

function hash(...parts: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of parts) {
    hasher.update(part)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

export namespace ClarusAssignmentRuntime {
  export async function dispatch(input: {
    host: ChannelHost.Instance
    accountId: string
    event: RuntimeTaskAssignedEvent
    agentOverride?: string
  }): Promise<{ assignment: ClarusAssignment; created: boolean }> {
    const title = ClarusAssignmentPrompt.title(input.event)
    let assignment: ClarusAssignment | undefined
    const result = await input.host.tasks.dispatch({
      externalProjectId: input.event.projectID,
      externalTaskId: input.event.taskID,
      deliveryKey: `clarus-assignment:${hash(input.accountId, input.event.projectID, input.event.taskID, input.event.runID)}`,
      title,
      text: ClarusAssignmentPrompt.userPrompt(input.accountId, input.event),
      agent: input.agentOverride,
      retryOfTaskID: input.event.retryOfTaskID,
      systemGuidance: {
        deliveryKey: `clarus-participation:${hash(input.accountId, input.event.projectID, input.event.taskID, input.event.runID)}`,
        text: ClarusAssignmentPrompt.participationGuidance(input.event),
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
    if (!assignment) throw new Error("Clarus assignment state was not persisted before task activation")
    return { assignment, created: result.deliveryCreated }
  }
}
