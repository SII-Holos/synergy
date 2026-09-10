import { Lock } from "../../util/lock"
import { RolloutProcess } from "./process"
import { Session } from ".."
import { MessageV2 } from "../message-v2"
import { SessionHistory } from "../history"
import { SessionProgress } from "../progress"
import { SessionInbox } from "../inbox"
import { SessionWorkflowService } from "../workflow"
import { Storage } from "../../storage/storage"
import { RolloutLedger } from "./ledger"
import type { RolloutSchema } from "./schema"
import { RolloutRecordingError } from "./error"
import { Config } from "../../config/config"
import { Experiment } from "../../config/experiment"
import { SessionManager } from "../manager"
import { LoopJob } from "../loop-job"
import { SessionCortexRuntime } from "../cortex-runtime"

export namespace RolloutLifecycle {
  export function owner(session: Session.Info): RolloutSchema.Owner {
    return { kind: "session", scopeID: session.scope.id, sessionID: session.id }
  }

  export async function parent(session: Session.Info): Promise<RolloutSchema.RunRecord["parent"]> {
    if (!session.cortex) return undefined
    const source = await Session.get(session.cortex.parentSessionID)
    const messageID = session.cortex.parentMessageID
    const message = await MessageV2.get({ sessionID: source.id, messageID }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!message) return { owner: owner(source), runID: null, messageID }
    const runID = message.info.rootID ?? (message.info.role === "user" ? message.info.id : message.info.parentID)
    return { owner: owner(source), runID, messageID }
  }

  export async function start(session: Session.Info, root: MessageV2.User, parts: MessageV2.Part[]) {
    const hash = new Bun.CryptoHasher("sha256")
    let messages = 0
    for await (const message of MessageV2.stream({ sessionID: session.id })) {
      if (message.info.id === root.id) continue
      hash.update(Experiment.fingerprint(message))
      messages++
    }
    return RolloutLedger.beginSegment({
      owner: owner(session),
      runID: root.id,
      input: JSON.parse(JSON.stringify({ message: root, parts })),
      parent: await parent(session),
      initialHistory: { messages, sha256: hash.digest("hex") },
    })
  }

  export async function configuration(
    session: Session.Info,
    runID: string,
    file?: Experiment.File,
    model?: { providerID: string; modelID: string },
  ) {
    const existing = await RolloutLedger.getRun(owner(session), runID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (existing?.configuration) return existing.configuration
    if (file) Experiment.assertRuntime(file.runtime)
    const lineage = await parent(session)
    const inherited = lineage?.runID
      ? (
          await RolloutLedger.getRun(lineage.owner, lineage.runID).catch((error) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
        )?.configuration
      : undefined
    if (inherited && file) throw new Error("Delegated runs inherit their parent experiment")
    const resolution = inherited ? undefined : await Config.resolveExecutionDetails()
    const snapshot =
      inherited ??
      Experiment.capture(
        resolution!.config,
        file,
        model ? { model: `${model.providerID}/${model.modelID}` } : {},
        resolution!.sources,
      )
    return RolloutLedger.configureRun(owner(session), runID, snapshot)
  }

  export async function cancel(sessionID: string, runID: string) {
    const session = await Session.get(sessionID)
    const identity = owner(session)
    const run = await RolloutLedger.requestCancel(identity, runID)
    if (run.status !== "running") return run
    for (const item of await SessionInbox.list(sessionID))
      if (item.messageID === runID) await SessionInbox.remove({ sessionID, itemID: item.id })
    SessionManager.signalAbort(sessionID, { rootID: runID })
    await Promise.all(
      (await Session.children(sessionID)).map(async (child) => {
        if ((await parent(child))?.runID !== runID) return
        if (child.cortex) await SessionCortexRuntime.cancelAndDrainTask(child.cortex.taskID)
      }),
    )
    const latest = (await SessionHistory.modelMessages({ sessionID })).findLast(
      (message) => message.info.role === "user" && message.info.isRoot,
    )
    if (latest?.info.id === runID && session.workflow)
      await SessionWorkflowService.setNone(sessionID, { allowRunning: true })
    while (SessionManager.getRuntime(sessionID)?.owner?.rootID === runID) await Bun.sleep(20)
    // Detached turn work no longer observes the lease abort; cancel it
    // explicitly and let its ledger writes settle before the run is closed.
    LoopJob.cancelDetached(sessionID, new Set([runID]))
    await LoopJob.settleDetached(sessionID, new Set([runID]))
    await RolloutProcess.cancel(identity, runID)
    using lock = await Lock.write(`session-rollout:${sessionID}:${runID}`)
    if (!(await RolloutLedger.segments(identity, runID)).some((segment) => segment.status === "running"))
      await settleOrphanedRecords(identity, runID)
    return RolloutLedger.finishRun(identity, runID, "cancelled")
  }

  /**
   * A silent run (no running segment) whose call/tool/process records are
   * still "running" holds orphans from an interrupted turn: the abort path
   * skips their completion and finishRun would refuse the run forever
   * after. Settle them as interrupted so finalize can proceed; the ledger
   * finishers are idempotent, so repeated reconciles stay safe.
   */
  async function settleOrphanedRecords(identity: RolloutSchema.Owner, runID: string) {
    for (const call of await RolloutLedger.calls(identity, runID)) {
      if (call.status !== "running") continue
      await RolloutLedger.finishCall(identity, runID, call.id, {
        status: "interrupted",
        error: "Turn ended before call completion",
      })
    }
    for (const tool of await RolloutLedger.tools(identity, runID)) {
      if (tool.status !== "running") continue
      await RolloutLedger.writeTool({
        ...tool,
        status: "interrupted",
        ended: Date.now(),
        error: "Turn ended; external side-effect completion is unknown",
      })
    }
    for (const process of await RolloutLedger.processes(identity, runID)) {
      if (process.status !== "running" || RolloutProcess.isActive(identity, runID, process.id)) continue
      await RolloutLedger.writeProcess({ ...process, status: "interrupted", ended: Date.now() })
    }
  }

  export async function reconcile(sessionID: string, runID: string, outcome?: "failed" | "cancelled") {
    using lock = await Lock.write(`session-rollout:${sessionID}:${runID}`)
    const session = await Session.get(sessionID)
    const identity = owner(session)
    const run = await RolloutLedger.getRun(identity, runID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!run || run.status !== "running") return run
    if (run.recording === "failed" && !outcome) {
      throw new RolloutRecordingError({ message: "Cannot complete a rollout whose recording failed" })
    }
    const segments = await RolloutLedger.segments(identity, runID)
    if (segments.some((segment) => segment.status === "running")) return run
    await settleOrphanedRecords(identity, runID)
    const lastSegment = segments.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id)).at(-1)
    outcome ??= lastSegment?.status === "failed" || lastSegment?.status === "cancelled" ? lastSegment.status : undefined
    for (const child of await Session.children(sessionID)) {
      if (!child.cortex) continue
      const lineage = await parent(child)
      if (lineage?.runID !== runID) continue
      if (child.cortex.status === "queued" || child.cortex.status === "running" || !child.cortex.settledAt) return run
    }
    if (!outcome && (await SessionWorkflowService.hasPendingExecution(session))) return run
    if (!outcome && (await SessionInbox.list(sessionID)).some((item) => item.mode === "steer")) return run
    const messages = await SessionHistory.modelMessages({ sessionID })
    const terminal = SessionProgress.findTerminalReply(messages, runID)
    if (!outcome && (!terminal || SessionProgress.needsModelCall(messages, runID))) return run
    const status = outcome ?? (terminal?.info.role === "assistant" && terminal.info.error ? "failed" : "completed")
    return RolloutLedger.finishRun(identity, runID, status)
  }
}
