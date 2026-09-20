import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInvoke, type InvokeInput } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionDrive } from "@ericsanchezok/synergy-harness/session/drive"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
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
  // The user is taking the session back, so the pause stops applying. Cleared
  // after the enqueue succeeds, so a failed enqueue cannot silently discard the
  // pause, and before the drive below, which the gate would otherwise refuse.
  await SessionLifecycle.clear(input.sessionID)
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

/**
 * Resume a session that stopped mid-work, from its breakpoint.
 *
 * Clearing the latch comes first because the drive gate refuses a paused
 * session even when the request is forced: the pause is the thing being
 * lifted. Continue is legal on a session that was never paused, so the clear
 * result is deliberately ignored rather than treated as a precondition.
 *
 * The latest root run is resumed for the same reason the inbox retry path
 * reopens one: an aborted turn's run was terminalized, and materialization
 * refuses to append a segment to a terminal rollout. `resumeRun` is the
 * user-initiated variant — `reopenRun` deliberately refuses a cancelled run so
 * an unattended retry cannot undo a cancellation, which is precisely the state
 * an abort leaves behind. Calling `reopenRun` here would make Continue a silent
 * no-op on the most common path. Both are idempotent and decide from the
 * persisted record under their own lock.
 */
export async function continueSession(sessionID: string): Promise<boolean> {
  const session = await Session.get(sessionID)
  await SessionLifecycle.clear(sessionID)
  const runID = await SessionInbox.latestRootID(sessionID)
  if (runID) await RolloutLedger.resumeRun(RolloutLifecycle.owner(session), runID)
  return SessionDrive.request(sessionID, "user-continue", { force: true, waitForProcessing: true })
}

/**
 * Give up on a session that stopped mid-work.
 *
 * Ordering is the contract: stop live work before repairing, because a running
 * turn would keep writing; terminalize and cancel the workflow before clearing
 * the latch, because clearing first would let the release drive resume the very
 * work the user is abandoning.
 */
export async function abandonSession(sessionID: string): Promise<SessionInvoke.AbortRepairState> {
  await Session.get(sessionID)
  SessionInvoke.cancel(sessionID)
  const state = await SessionInvoke.repairAbortState(sessionID, {
    terminalize: true,
    abandonWorkflow: true,
    pauseReason: "aborted",
  })
  await SessionLifecycle.clear(sessionID)
  return state
}
