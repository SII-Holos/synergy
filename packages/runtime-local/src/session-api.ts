import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInvoke, type InvokeInput } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionDrive } from "@ericsanchezok/synergy-harness/session/drive"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Worktree } from "./workspace/worktree"
import { Command } from "./command/command"

const log = Log.create({ service: "session-api" })

export async function assertSessionWorkspaceAvailable(sessionID: string) {
  const session = await Session.get(sessionID)
  if (session.workspace?.type !== "git_worktree") return
  await Worktree.assertAvailable(session.workspace.path)
}

export async function submitInput(input: InvokeInput): Promise<SessionInbox.InputResult> {
  await assertSessionWorkspaceAvailable(input.sessionID)
  if (input.model) await Provider.getModel(input.model.providerID, input.model.modelID)
  if (input.agent && !(await Agent.get(input.agent))) throw new Error(`Agent not found: ${input.agent}`)
  if (input.noReply === true && !SessionManager.isRunning(input.sessionID)) {
    const messageID = input.messageID ?? Identifier.ascending("message")
    SessionInvoke.invoke({ ...input, messageID }).catch((error) => {
      log.error("failed to execute async no-reply input", { sessionID: input.sessionID, messageID, error })
    })
    return { status: "started", messageID }
  }

  const item = await SessionInbox.enqueueUser(input)
  void SessionDrive.request(input.sessionID, "user-input").catch((error) => {
    log.error("failed to schedule durable user input", {
      sessionID: input.sessionID,
      itemID: item.id,
      messageID: item.messageID,
      error,
    })
  })
  return { status: "queued", item }
}

export async function createSession(
  input?: Omit<NonNullable<Parameters<typeof Session.create>[0]>, "workspace"> & {
    workspace?: Session.WorkspaceSelection
  },
) {
  const { workspace, ...body } = input ?? {}
  const session = await Session.create(body)
  try {
    return await Session.applyWorkspaceSelection(session.id, workspace)
  } catch (error) {
    await Session.remove(session.id)
    throw error
  }
}

export async function submitCommand(input: Parameters<typeof SessionInvoke.command>[0]): Promise<void> {
  const command = await Command.require(input.command)
  const messageID = input.messageID ?? Identifier.ascending("message")
  await RolloutLifecycle.configuration(
    await Session.get(input.sessionID),
    messageID,
    input.experiment,
    input.model ? Provider.parseModel(input.model) : undefined,
  )
  if (command.kind === "action") {
    SessionManager.assertIdle(input.sessionID)
    await SessionInvoke.command({ ...input, messageID })
    return
  }
  void SessionInvoke.command({ ...input, messageID }).catch((error) => {
    log.error("failed to execute async command", { command: input.command, sessionID: input.sessionID, error })
  })
}
