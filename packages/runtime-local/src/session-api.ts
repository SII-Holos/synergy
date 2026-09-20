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
  // The user is taking the session back, before the drive below, which would
  // otherwise die on the terminal run the stop left behind.
  await takeSessionBack(input.sessionID)
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

/**
 * Take a stopped session back: lift the pause and make the interrupted
 * breakpoint resumable.
 *
 * Sending new input and pressing Continue are the two ways a user resumes a
 * session that stopped mid-work, so both owe the session the same two steps.
 * The latch is cleared first because the drive gate refuses a paused session
 * even when its request is forced: the pause is the thing being lifted.
 *
 * The latest root's run is resumed second because a stop terminalizes that run,
 * and materialization refuses to append a segment to a terminal rollout — so
 * without the resume the drive dies on the interrupted breakpoint and the
 * user's input strands in the inbox. `resumeRun` is the user-initiated variant;
 * `reopenRun` deliberately refuses a cancelled run so an unattended retry
 * cannot undo a cancellation, which is exactly the state a stop leaves behind.
 * Both steps are idempotent and decide from the persisted record under their
 * own lock, so neither needs a precondition.
 *
 * A live turn owns the run and its release drives the queue, so it is left
 * alone: resuming underneath it would clear a cancellation still landing.
 */
async function takeSessionBack(sessionID: string): Promise<void> {
  const session = await Session.get(sessionID)
  await SessionLifecycle.clear(sessionID)
  if (SessionManager.isRunning(sessionID)) return
  const runID = await SessionInbox.latestRootID(sessionID)
  if (runID) await RolloutLedger.resumeRun(RolloutLifecycle.owner(session), runID)
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
 * The take-back is the shared `takeSessionBack` step. Continue is additionally
 * forced because the shared continuation gate requires a *terminal* assistant
 * on the latest reply-required root while an interrupted turn is deliberately
 * non-terminal, so a plain request would find nothing to do. `force` skips only
 * that discovery, so it cannot manufacture work or bypass the pause. Continue
 * is legal on a session that was never paused, so no take-back step is treated
 * as a precondition.
 */
export async function continueSession(sessionID: string): Promise<boolean> {
  await takeSessionBack(sessionID)
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
