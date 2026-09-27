import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInvoke, type InvokeInput } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionDrive } from "@ericsanchezok/synergy-harness/session/drive"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { SessionInputProgress } from "@ericsanchezok/synergy-harness/session/input-progress"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Command } from "./command/command"

const log = Log.create({ service: "session-api" })

export async function submitInput(input: InvokeInput): Promise<SessionInbox.InputResult> {
  await Session.assertWorkspaceAvailable(input.sessionID)
  if (input.model) await Provider.getModel(input.model.providerID, input.model.modelID)
  if (input.agent && !(await Agent.get(input.agent))) throw new Error(`Agent not found: ${input.agent}`)
  if (input.noReply === true && !SessionManager.isRunning(input.sessionID)) {
    const messageID = input.messageID ?? Identifier.ascending("message")
    SessionInvoke.invoke({ ...input, messageID }).catch((error) => {
      log.error("failed to execute async no-reply input", { sessionID: input.sessionID, messageID, error })
    })
    return { status: "started", messageID }
  }

  let item: SessionInbox.Item
  let runID: string | undefined
  {
    using control = await Lock.write(`session-control:${input.sessionID}`)
    if (input.messageID) {
      const existing = await MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).catch(
        (error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        },
      )
      if (existing) return { status: "started", messageID: input.messageID }
    }
    const paused = await SessionLifecycle.snapshot(input.sessionID)
    if (paused) await SessionManager.waitForIdle(input.sessionID)
    const rootID = paused ? await SessionInbox.latestRootID(input.sessionID) : undefined
    item = await SessionInbox.enqueueUser(input, rootID ? { mode: "steer" } : undefined)
    runID = rootID
    await takeSessionBack(input.sessionID)
  }
  scheduleInput(item, "user-input")
  return { status: "queued", item, runID }
}

function scheduleInput(item: SessionInbox.Item, reason: string) {
  void SessionDrive.request(item.sessionID, reason).catch((error) => {
    SessionInputProgress.schedulingFailure(item.sessionID, error, false)
    SessionManager.scheduleWake(item.sessionID, "durable-input-recovery")
    log.error("failed to schedule durable user input", {
      sessionID: item.sessionID,
      itemID: item.id,
      messageID: item.messageID,
      error,
    })
  })
}

export async function retryInput(input: { sessionID: string; itemID: string }): Promise<SessionInbox.Item> {
  await Session.assertWorkspaceAvailable(input.sessionID)
  let item: SessionInbox.Item
  {
    using control = await Lock.write(`session-control:${input.sessionID}`)
    if (await SessionLifecycle.snapshot(input.sessionID)) await SessionManager.waitForIdle(input.sessionID)
    item = await SessionInbox.rearm(input)
    if (item.mode === "task") await SessionLifecycle.clear(input.sessionID)
    else await takeSessionBack(input.sessionID)
  }
  scheduleInput(item, "user-input-retry")
  return item
}

export async function restoreInput(input: { sessionID: string; itemID: string }): Promise<void> {
  await Session.assertWorkspaceAvailable(input.sessionID)
  using control = await Lock.write(`session-control:${input.sessionID}`)
  const result = await SessionInbox.restore(input)
  if (result.restored && result.item.status !== "failed") scheduleInput(result.item, "user-input-restored")
}

async function takeSessionBack(sessionID: string): Promise<void> {
  const session = await Session.get(sessionID)
  if (session.paused) await SessionManager.waitForIdle(sessionID)
  if (session.paused && !SessionManager.isRunning(sessionID)) {
    const runID = await SessionInbox.latestRootID(sessionID)
    if (runID) await RolloutLedger.resumeRun(RolloutLifecycle.owner(session), runID)
  }
  await SessionLifecycle.clear(sessionID)
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
  await Session.assertWorkspaceAvailable(input.sessionID)
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
 * forced when the session really is holding an interrupted breakpoint: the
 * shared continuation gate requires a *terminal* assistant on the latest
 * reply-required root, while an interrupted turn is deliberately non-terminal,
 * so a plain request would find nothing to do.
 *
 * That force is conditional because it is precisely what lets Continue resume
 * work the gate cannot discover — and equally able to drive a session that has
 * nothing pending, which leaves the loop with no result to report and fails the
 * request. A session with no breakpoint takes the ordinary path instead, which
 * still consumes queued work and honestly reports that it handled nothing.
 * Continue is legal on a session that was never paused, so no take-back step
 * is treated as a precondition.
 */
export async function continueSession(sessionID: string): Promise<boolean> {
  let interrupted: boolean
  {
    using control = await Lock.write(`session-control:${sessionID}`)
    await takeSessionBack(sessionID)
    const messages = await SessionHistory.modelMessages({ sessionID })
    interrupted = SessionProgress.pendingReply(messages)
  }
  return SessionDrive.request(sessionID, "user-continue", {
    ...(interrupted ? { force: true } : {}),
    waitForProcessing: true,
  })
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
  const state = await SessionAbort.abort(sessionID, {
    terminalize: true,
    abandonWorkflow: true,
    pauseReason: "aborted",
  })
  return { repaired: state.repaired, paused: state.paused, abandoned: state.abandoned }
}
