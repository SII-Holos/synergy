import { RolloutProvenance } from "./provenance"
import { RolloutJournal } from "./journal"
import { RolloutAccounting } from "./accounting"
import z from "zod"
import { Identifier } from "../../id/id"
import { Storage } from "../../storage/storage"
import { Lock } from "../../util/lock"
import { RolloutArtifact } from "./artifact"
import { RolloutSchema } from "./schema"
import { record, RolloutRecordingError } from "./error"

export namespace RolloutLedger {
  type Owner = RolloutSchema.Owner
  type Terminal = Exclude<RolloutSchema.CallRecord["status"], "running">
  const Segment = z.string().regex(/^[a-zA-Z0-9_-]+$/)
  const recordingFailures = new Map<string, InstanceType<typeof RolloutRecordingError>>()

  export async function failRecording(owner: Owner, runID: string, error: InstanceType<typeof RolloutRecordingError>) {
    const key = lockKey(owner, runID)
    recordingFailures.set(key, error)
    using lock = await Lock.write(key)
    try {
      const current = await getRun(owner, runID)
      await RolloutJournal.write(owner, [...root(owner, runID), "info"], { ...current, recording: "failed" })
      recordingFailures.delete(key)
    } catch {
      // Keep admission closed in memory when even the failure marker cannot be written.
    }
  }

  function root(owner: Owner, runID: string) {
    return [...RolloutArtifact.root(owner), "runs", Segment.parse(runID)]
  }

  function lockKey(owner: Owner, runID: string) {
    return `rollout:${root(owner, runID).join(":")}`
  }

  export async function beginRun(owner: Owner, runID: string) {
    using lock = await Lock.write(lockKey(owner, runID))
    return requireRunning(owner, runID)
  }

  export async function configureRun(
    owner: Owner,
    runID: string,
    configuration: NonNullable<RolloutSchema.RunRecord["configuration"]>,
  ) {
    using lock = await Lock.write(lockKey(owner, runID))
    const run = await requireRunning(owner, runID)
    if (run.configuration) return run.configuration
    const provenance = await record(() => RolloutProvenance.capture())
    await record(() =>
      RolloutJournal.write(owner, [...root(owner, runID), "info"], { ...run, configuration, provenance }),
    )
    return configuration
  }

  export async function attachInput(owner: Owner, runID: string, artifact: RolloutSchema.ArtifactRef) {
    using lock = await Lock.write(lockKey(owner, runID))
    const run = await requireRunning(owner, runID)
    const attachments = run.attachments ?? []
    if (attachments.some((ref) => ref.id === artifact.id)) return
    await record(() =>
      RolloutJournal.write(owner, [...root(owner, runID), "info"], { ...run, attachments: [...attachments, artifact] }),
    )
  }

  export async function getRun(owner: Owner, runID: string) {
    return RolloutSchema.RunRecord.parse(await Storage.read([...root(owner, runID), "info"]))
  }

  export async function requestCancel(owner: Owner, runID: string) {
    using lock = await Lock.write(lockKey(owner, runID))
    const run = await getRun(owner, runID)
    if (run.status !== "running" || run.cancelRequestedAt) return run
    const updated = { ...run, cancelRequestedAt: Date.now() }
    await record(() => RolloutJournal.write(owner, [...root(owner, runID), "info"], updated))
    return updated
  }

  export async function beginSegment(input: {
    owner: Owner
    runID: string
    input: z.infer<ReturnType<typeof z.json>>
    initialHistory?: RolloutSchema.RunRecord["initialHistory"]
    parent?: RolloutSchema.RunRecord["parent"]
  }) {
    using lock = await Lock.write(lockKey(input.owner, input.runID))
    const previous = await getRun(input.owner, input.runID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (previous?.status === "interrupted" && previous.recording !== "failed") {
      await record(() =>
        RolloutJournal.write(input.owner, [...root(input.owner, input.runID), "info"], {
          ...previous,
          ended: undefined,
          status: "running",
          recording: "partial",
        }),
      )
    }
    const run = await requireRunning(input.owner, input.runID)
    if (!run.input) {
      const artifact = await RolloutArtifact.writeText(input.owner, JSON.stringify(input.input), "application/json")
      await record(() =>
        RolloutJournal.write(input.owner, [...root(input.owner, input.runID), "info"], {
          ...run,
          input: artifact,
          parent: input.parent,
          initialHistory: input.initialHistory,
        }),
      )
    }
    const segment = RolloutSchema.ExecutionSegment.parse({
      version: 1,
      id: crypto.randomUUID(),
      owner: input.owner,
      runID: input.runID,
      started: Date.now(),
      status: "running",
    })
    await record(() =>
      RolloutJournal.write(input.owner, [...root(input.owner, input.runID), "segments", segment.id], segment),
    )
    return segment
  }

  export async function segments(owner: Owner, runID: string) {
    const base = [...root(owner, runID), "segments"]
    const ids = await Storage.scan(base, { strict: true })
    return Promise.all(ids.map(async (id) => RolloutSchema.ExecutionSegment.parse(await Storage.read([...base, id]))))
  }

  export async function finishSegment(segment: RolloutSchema.ExecutionSegment, status: Terminal) {
    using lock = await Lock.write(lockKey(segment.owner, segment.runID))
    const key = [...root(segment.owner, segment.runID), "segments", segment.id]
    return record(async () => {
      const current = RolloutSchema.ExecutionSegment.parse(await Storage.read(key))
      if (current.status !== "running") return current
      const completed = RolloutSchema.ExecutionSegment.parse({ ...current, status, ended: Date.now() })
      await RolloutJournal.write(segment.owner, key, completed)
      return completed
    })
  }

  export async function getCall(owner: Owner, runID: string, callID: string) {
    return RolloutSchema.CallRecord.parse(await Storage.read([...root(owner, runID), "calls", Segment.parse(callID)]))
  }

  export async function calls(owner: Owner, runID: string) {
    const ids = await Storage.scan([...root(owner, runID), "calls"], { strict: true })
    const result: RolloutSchema.CallRecord[] = []
    for (const id of ids) result.push(await getCall(owner, runID, id))
    return result
  }

  export async function summarizeCalls(owner: Owner, runID: string, callIDs: string[]) {
    const records = await Promise.all([...new Set(callIDs)].map((id) => getCall(owner, runID, id)))
    const requests = await Promise.all(records.map((call) => attempts(owner, runID, call.id)))
    return RolloutAccounting.summarize({ calls: records, attempts: requests.flat(), gaps: [] })
  }

  function attemptRoot(owner: Owner, runID: string, callID: string) {
    return [...root(owner, runID), "attempts", Segment.parse(callID)]
  }

  export async function attempts(owner: Owner, runID: string, callID: string) {
    const base = attemptRoot(owner, runID, callID)
    const ids = await Storage.scan(base, { strict: true })
    const result: RolloutSchema.AttemptRecord[] = []
    for (const id of ids) result.push(RolloutSchema.AttemptRecord.parse(await Storage.read([...base, id])))
    return result.sort((a, b) => a.index - b.index)
  }

  export async function writeAttempt(value: RolloutSchema.AttemptRecord) {
    const attempt = RolloutSchema.AttemptRecord.parse(value)
    await writeExecution([...attemptRoot(attempt.owner, attempt.runID, attempt.callID), attempt.id], attempt)
  }

  async function writeExecution<T extends { owner: Owner; runID: string; id: string; started: number; status: string }>(
    key: string[],
    value: T,
  ) {
    return record(async () => {
      using lock = await Lock.write(`rollout-record:${key.join(":")}`)
      const current = await Storage.read<T>(key).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (current && current.status !== "running") return current
      if (
        current &&
        (current.id !== value.id ||
          current.runID !== value.runID ||
          current.started !== value.started ||
          JSON.stringify(current.owner) !== JSON.stringify(value.owner))
      )
        throw new Error("Rollout execution identity changed")
      await RolloutJournal.write(value.owner, key, value)
      return value
    })
  }

  async function requireRunning(owner: Owner, runID: string) {
    const failure = recordingFailures.get(lockKey(owner, runID))
    if (failure) throw failure
    let run: RolloutSchema.RunRecord
    try {
      run = await getRun(owner, runID)
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) {
        throw new RolloutRecordingError({ message: "Unable to read rollout state" }, { cause: error })
      }
      run = {
        version: 1,
        id: runID,
        owner: owner,
        started: Date.now(),
        status: "running",
        recording: "partial",
      }
      await record(() => RolloutJournal.write(owner, [...root(owner, runID), "info"], run))
    }
    if (run.recording === "failed") throw new RolloutRecordingError({ message: "Rollout recording has already failed" })
    if (run.cancelRequestedAt) throw new DOMException("Run was cancelled", "AbortError")
    if (run.status !== "running") throw new Error("Cannot append execution to a terminal rollout")
    return run
  }

  export async function tools(owner: Owner, runID: string) {
    const base = [...root(owner, runID), "tools"]
    const ids = await Storage.scan(base, { strict: true })
    const result: RolloutSchema.ToolExecutionRecord[] = []
    for (const id of ids) result.push(RolloutSchema.ToolExecutionRecord.parse(await Storage.read([...base, id])))
    return result
  }

  export async function processes(owner: Owner, runID: string) {
    const base = [...root(owner, runID), "processes"]
    const ids = await Storage.scan(base, { strict: true })
    const result: RolloutSchema.ProcessRecord[] = []
    for (const id of ids) result.push(RolloutSchema.ProcessRecord.parse(await Storage.read([...base, id])))
    return result
  }

  export async function writeProcess(input: RolloutSchema.ProcessRecord) {
    const value = RolloutSchema.ProcessRecord.parse(input)
    await writeExecution([...root(value.owner, value.runID), "processes", value.id], value)
  }

  export async function beginTool(input: {
    owner: Owner
    runID: string
    messageID: string
    toolCallID: string
    tool: string
    args: z.infer<ReturnType<typeof z.json>>
  }) {
    using lock = await Lock.write(lockKey(input.owner, input.runID))
    await requireRunning(input.owner, input.runID)
    const artifact = await RolloutArtifact.writeText(input.owner, JSON.stringify(input.args), "application/json")
    const tool = RolloutSchema.ToolExecutionRecord.parse({
      version: 1,
      id: crypto.randomUUID(),
      owner: input.owner,
      runID: input.runID,
      messageID: input.messageID,
      toolCallID: input.toolCallID,
      tool: input.tool,
      started: Date.now(),
      status: "running",
      input: artifact,
    })
    await writeTool(tool)
    const failure = recordingFailures.get(lockKey(input.owner, input.runID))
    if (failure) throw failure
    return tool
  }

  export async function writeTool(input: RolloutSchema.ToolExecutionRecord) {
    const value = RolloutSchema.ToolExecutionRecord.parse(input)
    await writeExecution([...root(value.owner, value.runID), "tools", value.id], value)
  }

  export async function beginCall(input: {
    owner: Owner
    runID: string
    purpose: string
    kind?: RolloutSchema.CallRecord["kind"]
    execution?: RolloutSchema.CallRecord["execution"]
    parentCallID?: string
    agent?: string
    model: z.infer<typeof RolloutSchema.Model>
    request: z.infer<ReturnType<typeof z.json>>
  }) {
    using lock = await Lock.write(lockKey(input.owner, input.runID))
    await requireRunning(input.owner, input.runID)
    const request = await RolloutArtifact.writeText(input.owner, JSON.stringify(input.request), "application/json")
    const call = RolloutSchema.CallRecord.parse({
      version: 1,
      id: Identifier.ascending("rollout_call"),
      owner: input.owner,
      runID: input.runID,
      purpose: input.purpose,
      kind: input.kind,
      execution: input.execution,
      parentCallID: input.parentCallID,
      agent: input.agent,
      model: input.model,
      request,
      started: Date.now(),
      status: "running",
      sdkUsage: null,
      transportCaptured: false,
    })
    await record(() => RolloutJournal.write(input.owner, [...root(input.owner, input.runID), "calls", call.id], call))
    const interrupted = recordingFailures.get(lockKey(input.owner, input.runID))
    if (interrupted) throw interrupted
    return call
  }

  export async function finishCall(
    owner: Owner,
    runID: string,
    callID: string,
    result: {
      status: Terminal
      response?: RolloutSchema.ArtifactRef
      sdkUsage?: z.infer<ReturnType<typeof z.json>>
      transportCaptured?: boolean
      error?: string
    },
  ) {
    using lock = await Lock.write(lockKey(owner, runID))
    return record(async () => {
      const current = await getCall(owner, runID, callID)
      if (current.status !== "running") return current
      const completed = RolloutSchema.CallRecord.parse({
        ...current,
        ...result,
        sdkUsage: result.sdkUsage === undefined ? current.sdkUsage : result.sdkUsage,
        ended: Date.now(),
      })
      await RolloutJournal.write(owner, [...root(owner, runID), "calls", callID], completed)
      return completed
    })
  }

  export async function checkpointCall(
    owner: Owner,
    runID: string,
    callID: string,
    response: RolloutSchema.ArtifactRef,
  ) {
    using lock = await Lock.write(lockKey(owner, runID))
    return record(async () => {
      const current = await getCall(owner, runID, callID)
      if (current.status !== "running") return
      if (current.response && (current.response.id !== response.id || current.response.bytes > response.bytes))
        throw new Error("Rollout response checkpoint regressed")
      const updated = RolloutSchema.CallRecord.parse({ ...current, response })
      await RolloutJournal.write(owner, [...root(owner, runID), "calls", callID], updated)
    })
  }

  export async function finishRun(owner: Owner, runID: string, status: Terminal) {
    using lock = await Lock.write(lockKey(owner, runID))
    const current = await getRun(owner, runID)
    const recordingFailed = current.recording === "failed" || recordingFailures.has(lockKey(owner, runID))
    if (recordingFailed && status === "completed") {
      throw new RolloutRecordingError({ message: "Cannot complete a rollout whose recording failed" })
    }
    if (current.status !== "running") return current
    const active = await segments(owner, runID)
    if (active.some((segment) => segment.status === "running")) throw new Error("Rollout still has active segments")
    const records = await calls(owner, runID)
    if (records.some((call) => call.status === "running")) throw new Error("Rollout still has active calls")
    const executions = await tools(owner, runID)
    const children = await processes(owner, runID)
    if (executions.some((tool) => tool.status === "running")) throw new Error("Rollout still has active tools")
    const completed: RolloutSchema.RunRecord = {
      ...current,
      status: current.cancelRequestedAt ? "cancelled" : status,
      ended: Date.now(),
      recording: recordingFailed
        ? "failed"
        : (!current.parent || current.parent.runID !== null) &&
            records.every(
              (call) => (call.execution === "local" || call.transportCaptured) && call.response?.status === "complete",
            ) &&
            executions.every(
              (tool) => tool.rawResult?.status === "complete" && tool.observation?.status === "complete",
            ) &&
            children.every((process) => process.stream.status === "complete")
          ? "complete"
          : "partial",
    }
    await record(() => RolloutJournal.write(owner, [...root(owner, runID), "info"], completed))
    recordingFailures.delete(lockKey(owner, runID))
    return completed
  }
}
