import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import {
  RolloutAccounting,
  RolloutEvidence,
  RolloutEvents,
  RolloutSchema,
  RolloutSnapshot,
} from "@ericsanchezok/synergy-harness/rollout"
import { Usage, type UsageSchema } from "@ericsanchezok/synergy-harness/usage"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { ObservabilitySpans } from "@ericsanchezok/synergy-harness/observability/spans"
import { ExecutionSchema } from "./schema"
import { ExecutionActivity } from "./activity"
import { ExecutionPresentation } from "./presentation"
import { ExecutionContent } from "./content"
import { ExecutionProcess } from "./process"

export namespace ExecutionService {
  const log = Log.create({ service: "execution" })
  type Evidence = { owner: RolloutSchema.Owner; record: RolloutEvents.Record }
  type Data = {
    root: Session.Info
    sessions: Session.Info[]
    snapshots: RolloutSnapshot.Info[]
    nodes: ExecutionSchema.Node[]
    evidence: Map<string, Evidence>
    messages: Map<string, { sessionID: string; messageID: string; partID: string }>
    usage: Map<string, UsageSchema.Record>
    contexts: Map<string, NonNullable<MessageV2.Assistant["contextUsage"]>>
    revision: number
    summary: ExecutionSchema.Summary
    touched: number
    pendingMessages: Map<string, string>
    changed: Set<string>
    removed: Set<string>
    refreshChildren: boolean
    selections: Map<string, { summary: ExecutionSchema.Summary; touched: number }>
    processRows: Map<string, ExecutionSchema.Node>
    recordRows: Map<string, ExecutionSchema.Node>
    publishedRevision: number
  }
  const state = RuntimeContext.state(() => ({
    entries: new Map<string, Data>(),
    pending: new Map<string, Promise<Data>>(),
    timers: new Map<string, ReturnType<typeof setTimeout>>(),
    dirty: new Set<string>(),
    sequence: 0,
    bufferVersion: 0,
    buffered: new Map<string, { owner: RolloutSchema.Owner; revision: number; record: RolloutEvents.Record }>(),
    bufferedMessages: new Map<string, string>(),
    bufferedUsage: new Map<string, UsageSchema.Record>(),
    bufferedSessions: new Map<string, Session.Info>(),
    dispose: undefined as (() => void) | undefined,
  }))
  const preview = (value: string) => value.replace(/\s+/g, " ").slice(0, 240)
  const nodeID = (sessionID: string, kind: string, id: string) =>
    Buffer.from(JSON.stringify([sessionID, kind, id])).toString("base64url")
  function rootID(record: RolloutEvents.Record) {
    return record.kind === "run" ? record.value.id : record.value.runID
  }
  function nodesFor(snapshot: RolloutSnapshot.Info, session: Session.Info) {
    const result: ExecutionSchema.Node[] = []
    const evidence = new Map<string, Evidence>()
    const add = (record: RolloutEvents.Record) => {
      if (record.kind === "segment") return
      const value = record.value
      const runID = rootID(record)
      const parentID =
        record.kind === "run"
          ? session.parentID
            ? record.value.parent?.runID
              ? nodeID(session.parentID, "run", record.value.parent.runID)
              : null
            : null
          : record.kind === "attempt"
            ? nodeID(session.id, "call", record.value.callID)
            : record.kind === "process"
              ? nodeID(session.id, "tool", record.value.toolExecutionID)
              : nodeID(session.id, "run", runID)
      const kind =
        record.kind === "run"
          ? session.parentID
            ? "subtask"
            : "turn"
          : record.kind === "call"
            ? record.value.usageRole === "compaction"
              ? "compaction"
              : "model"
            : record.kind === "attempt"
              ? record.value.index > 0
                ? "retry"
                : "model"
              : record.kind
      const title =
        record.kind === "call"
          ? record.value.model.modelID
          : record.kind === "attempt"
            ? String(record.value.index + 1)
            : record.kind === "tool"
              ? record.value.tool
              : record.kind === "process"
                ? String(record.value.pid ?? record.value.id)
                : (session.cortex?.description ?? session.title)
      const subtitle =
        record.kind === "call"
          ? record.value.purpose
          : record.kind === "tool"
            ? (record.value.error ?? "")
            : record.kind === "attempt"
              ? (record.value.error ?? (record.value.httpStatus ? String(record.value.httpStatus) : ""))
              : ""
      const node = ExecutionSchema.Node.parse({
        id: nodeID(session.id, record.kind, value.id),
        sessionID: session.id,
        runID,
        parentID,
        kind,
        title,
        preview: preview(subtitle),
        started: value.started,
        ended: value.ended,
        status: value.status,
        revision: snapshot.revision,
        source: "recorded",
        evidenceKind: record.kind,
        ...(record.kind === "run" && session.parentID
          ? {
              attribution: record.value.parent?.runID ? "known" : "unassigned",
              tokens: RolloutAccounting.summarize({
                calls: snapshot.calls.filter((call) => call.runID === runID),
                attempts: snapshot.attempts.filter((attempt) => attempt.runID === runID),
                gaps: snapshot.gaps,
              }).tokens.total,
            }
          : {}),
        ...(record.kind === "tool" ? { messageID: record.value.messageID, tool: record.value.tool } : {}),
        ...(record.kind === "call"
          ? {
              modelID: record.value.model.modelID,
              modelKind: record.value.kind,
              agent: record.value.agent,
              callID: value.id,
              purpose: record.value.purpose,
              usageRole: record.value.usageRole,
            }
          : {}),
        ...(record.kind === "attempt"
          ? { callID: record.value.callID, modelID: record.value.responseModel, attemptIndex: record.value.index }
          : {}),
      })
      result.push(node)
      evidence.set(node.id, { owner: snapshot.owner, record })
    }
    for (const value of snapshot.runs) add({ kind: "run", value })
    for (const value of snapshot.calls) add({ kind: "call", value })
    for (const value of snapshot.attempts) add({ kind: "attempt", value })
    for (const value of snapshot.tools) add({ kind: "tool", value })
    for (const value of snapshot.processes) add({ kind: "process", value })
    return { nodes: result, evidence }
  }
  function messageCall(info: MessageV2.Info, parts: MessageV2.Part[], partID: string) {
    if (info.role !== "assistant") return
    const index = parts.findIndex((part) => part.id === partID)
    const step = parts.slice(index + 1).find((part) => part.type === "step-finish" || part.type === "step-start")
    if (step?.type === "step-finish" && step.accounting?.kind === "rollout" && step.accounting.callIDs.length === 1)
      return step.accounting.callIDs[0]
    if (info.accounting?.kind === "rollout" && info.accounting.callIDs.length === 1) return info.accounting.callIDs[0]
  }
  function normalizedNode(info: MessageV2.Info, part: MessageV2.Part, revision: number, parts: MessageV2.Part[]) {
    const tool = part.type === "tool" ? part : undefined
    const kind = tool
      ? "tool"
      : part.type === "reasoning"
        ? "reasoning"
        : part.type === "compaction"
          ? "compaction"
          : part.type === "text"
            ? MessageV2.isSystemPart(part) || (info.role === "user" && !info.isRoot)
              ? "context"
              : info.role === "user"
                ? "input"
                : "output"
            : part.type === "attachment"
              ? "context"
              : undefined
    if (!kind) return
    const text = tool
      ? tool.state.status === "completed"
        ? tool.state.title
        : JSON.stringify(tool.state.input ?? {})
      : part.type === "text" || part.type === "reasoning"
        ? part.text
        : part.type === "attachment"
          ? (part.filename ?? part.mime)
          : ""
    const runID = info.rootID ?? info.id
    const callID = messageCall(info, parts, part.id)
    const started =
      tool && "time" in tool.state
        ? tool.state.time.start
        : "time" in part && part.time && "start" in part.time
          ? part.time.start
          : info.time.created
    const ended =
      tool && "time" in tool.state && "end" in tool.state.time
        ? tool.state.time.end
        : "time" in part && part.time && "end" in part.time
          ? part.time.end
          : info.role === "assistant"
            ? info.time.completed
            : info.time.created
    const status = tool
      ? tool.state.status === "error"
        ? "failed"
        : tool.state.status === "pending"
          ? "unknown"
          : tool.state.status
      : info.role === "assistant" && info.error
        ? "failed"
        : info.role === "assistant" && !info.time.completed
          ? "running"
          : "completed"
    return ExecutionSchema.Node.parse({
      id: nodeID(info.sessionID, "message", part.id),
      sessionID: info.sessionID,
      runID,
      parentID: callID ? nodeID(info.sessionID, "call", callID) : nodeID(info.sessionID, "run", runID),
      kind,
      title: tool?.tool ?? preview(text),
      preview: preview(text),
      started,
      ended,
      status,
      revision,
      messageID: info.id,
      tool: tool?.tool,
      agent: info.agent,
      source: "messages",
    })
  }
  function rememberContext(contexts: Data["contexts"], info: MessageV2.Info) {
    if (info.role !== "assistant" || !info.contextUsage || info.accounting?.kind !== "rollout") return
    const callID = info.accounting.callIDs.at(-1)
    if (callID) contexts.set(callID, info.contextUsage)
  }
  function selected(data: Data, runID?: string) {
    if (!runID) return data.nodes
    const allowed = new Set<string>([data.root.id + ":" + runID])
    for (const snapshot of data.snapshots) {
      for (const run of snapshot.runs) {
        if (
          run.parent?.owner.kind === "session" &&
          run.parent.runID &&
          allowed.has(run.parent.owner.sessionID + ":" + run.parent.runID)
        )
          allowed.add(snapshot.owner.kind === "session" ? snapshot.owner.sessionID + ":" + run.id : "")
      }
    }
    return data.nodes.filter((node) => allowed.has(node.sessionID + ":" + node.runID))
  }
  async function build(root: Session.Info): Promise<Data> {
    const sessions = [root]
    const seen = new Set([root.id])
    for (let index = 0; index < sessions.length; index++) {
      for (const child of await Session.children(sessions[index].id)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        sessions.push(child)
      }
    }
    const snapshots = await ObservabilitySpans.measure(
      { name: "execution.snapshot", module: "session", kind: "session" },
      () =>
        RolloutSnapshot.currentAll(
          sessions.map((session) => ({
            kind: "session",
            scopeID: session.scope.id,
            sessionID: session.id,
          })),
        ),
    )
    const nodes: ExecutionSchema.Node[] = []
    const evidence = new Map<string, Evidence>()
    const messages = new Map<string, { sessionID: string; messageID: string; partID: string }>()
    const contexts: Data["contexts"] = new Map()
    for (const [index, session] of sessions.entries()) {
      const snapshot = snapshots[index]
      const projected = nodesFor(snapshot, session)
      nodes.push(...projected.nodes)
      for (const [key, value] of projected.evidence) evidence.set(key, value)
      const raw: MessageV2.WithParts[] = []
      await ObservabilitySpans.measure({ name: "execution.messages", module: "session", kind: "session" }, async () => {
        for await (const message of MessageV2.stream({ sessionID: session.id })) raw.push(message)
      })
      for (const message of MessageV2.deriveSemantics(raw.toReversed())) {
        rememberContext(contexts, message.info)
        for (const part of message.parts) {
          if (part.type === "tool") {
            const tool = nodes.find(
              (node) =>
                node.sessionID === session.id &&
                node.kind === "tool" &&
                node.messageID === message.info.id &&
                evidence.get(node.id)?.record.kind === "tool" &&
                (evidence.get(node.id)!.record.value as RolloutSchema.ToolExecutionRecord).toolCallID === part.callID,
            )
            if (tool) {
              tool.preview = preview(
                part.state.status === "completed" ? part.state.title : JSON.stringify(part.state.input ?? {}),
              )
              const callID = messageCall(message.info, message.parts, part.id)
              if (callID && evidence.get(nodeID(session.id, "call", callID))?.record.kind === "call")
                tool.parentID = nodeID(session.id, "call", callID)
              tool.agent = message.info.agent
              continue
            }
          }
          const node = normalizedNode(message.info, part, 0, message.parts)
          if (!node) continue
          nodes.push(node)
          messages.set(node.id, { sessionID: session.id, messageID: message.info.id, partID: part.id })
        }
      }
    }
    nodes.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
    const usage = new Map<string, UsageSchema.Record>()
    for (const record of await ObservabilitySpans.measure(
      { name: "execution.usage", module: "session", kind: "session" },
      () => Usage.collect({ scopeID: root.scope.id, sessionID: root.id, includeDescendants: true }),
    ))
      usage.set(record.id, record)
    const revision = ++state().sequence
    const data = {
      root,
      sessions,
      snapshots,
      nodes,
      evidence,
      messages,
      usage,
      contexts,
      revision,
      touched: Date.now(),
      pendingMessages: new Map<string, string>(),
      changed: new Set<string>(),
      removed: new Set<string>(),
      refreshChildren: false,
      selections: new Map<string, { summary: ExecutionSchema.Summary; touched: number }>(),
      processRows: new Map(ExecutionProcess.project(nodes, "process", root.id).map((node) => [node.id, node])),
      recordRows: new Map(ExecutionProcess.project(nodes, "records", root.id).map((node) => [node.id, node])),
      publishedRevision: revision,
    } as Omit<Data, "summary">
    return { ...data, summary: await summarize(data) }
  }
  async function summarize(data: Omit<Data, "summary">, runID?: string): Promise<ExecutionSchema.Summary> {
    const nodes = selected(data as Data, runID)
    const identities = new Set(nodes.map((node) => node.sessionID + ":" + node.runID))
    const snapshots = data.snapshots.map((snapshot) => ({
      ...snapshot,
      runs: snapshot.runs.filter((run) =>
        identities.has((snapshot.owner.kind === "session" ? snapshot.owner.sessionID : "") + ":" + run.id),
      ),
      calls: snapshot.calls.filter((call) =>
        identities.has((snapshot.owner.kind === "session" ? snapshot.owner.sessionID : "") + ":" + call.runID),
      ),
      attempts: snapshot.attempts.filter((attempt) =>
        identities.has((snapshot.owner.kind === "session" ? snapshot.owner.sessionID : "") + ":" + attempt.runID),
      ),
    }))
    const accounting = snapshots.map(RolloutAccounting.summarize)
    const usage = Usage.summarize(
      [...data.usage.values()].filter(
        (record) =>
          !runID || (record.owner.kind === "session" && identities.has(record.owner.sessionID + ":" + record.runID)),
      ),
      { sessionID: data.root.id, runID, includeDescendants: true },
    )
    const runs = snapshots.flatMap((snapshot) => snapshot.runs)
    const roots = snapshots[0].runs
    const context = Usage.summarize(
      [...data.usage.values()].filter(
        (record) =>
          record.owner.kind === "session" &&
          record.owner.sessionID === data.root.id &&
          (!runID || record.runID === runID),
      ),
      { sessionID: data.root.id, runID, includeDescendants: false },
    )
    const start = nodes.reduce((value, node) => Math.min(value, node.started), Date.now())
    const end = nodes.reduce((value, node) => Math.max(value, node.ended ?? node.started), start + 1)
    const distribution = context.context && data.contexts.get(context.context.callID)
    const activity = ExecutionActivity.project(nodes, data.root.id)
    const activities = activity.nodes
    return ExecutionSchema.Summary.parse({
      sessionID: data.root.id,
      revision: data.revision,
      runID,
      computedAt: Date.now(),
      status: ExecutionPresentation.taskStatus(roots, runs),
      elapsedMs: ExecutionPresentation.measuredElapsed(roots),
      elapsedActive: roots.some((run) => run.status === "running" && run.ended == null),
      accounting: usage.accounting,
      cost: ExecutionPresentation.cost(usage.accounting),
      own: usage.own,
      descendants: usage.descendants,
      rates: usage.rates,
      cache: usage.cache,
      latency: usage.latency,
      outcomes: usage.outcomes,
      tools: usage.tools,
      context: context.context,
      contextDistribution:
        distribution &&
        distribution.modelID === context.context?.modelID &&
        distribution.totalInput === context.context.inputTokens
          ? distribution
          : null,
      tasks: data.sessions
        .slice(1)
        .map((session, index) => ({
          sessionID: session.id,
          parentID: session.parentID ?? null,
          title: session.cortex?.description ?? session.title,
          nodeID: nodes.find((node) => node.kind === "subtask" && node.sessionID === session.id)?.id ?? null,
          status: ExecutionPresentation.taskStatus(snapshots[index + 1].runs, []),
          elapsedMs: ExecutionPresentation.measuredElapsed(snapshots[index + 1].runs),
          elapsedActive: snapshots[index + 1].runs.some((run) => run.status === "running" && run.ended == null),
          tokens: accounting[index + 1].tokens.total,
          runs: snapshots[index + 1].runs.map((run) => run.id),
          interaction: session.interaction,
          cortex: session.cortex && {
            taskID: session.cortex.taskID,
            agent: session.cortex.agent,
            status: session.cortex.status,
            visibility: session.cortex.visibility,
          },
        }))
        .filter((task) => !runID || task.runs.length),
      rounds: [
        ...data.snapshots[0].runs.map((run) => {
          const roundIdentities = new Set(
            selected(data as Data, run.id).map((node) => node.sessionID + ":" + node.runID),
          )
          return {
            id: run.id,
            title:
              data.nodes.find(
                (node) => node.runID === run.id && node.sessionID === data.root.id && node.kind === "input",
              )?.preview ?? run.id,
            started: run.started,
            status: ExecutionPresentation.taskStatus(
              [run],
              data.snapshots.flatMap((snapshot) =>
                snapshot.runs.filter(
                  (candidate) =>
                    snapshot.owner.kind === "session" &&
                    roundIdentities.has(snapshot.owner.sessionID + ":" + candidate.id),
                ),
              ),
            ),
            elapsedMs: ExecutionPresentation.measuredElapsed([run]),
          }
        }),
        ...data.nodes
          .filter(
            (node) =>
              node.sessionID === data.root.id &&
              node.kind === "input" &&
              !data.snapshots[0].runs.some((run) => run.id === node.runID),
          )
          .filter((node, index, all) => all.findIndex((other) => other.runID === node.runID) === index)
          .map((node) => ({
            id: node.runID,
            title: node.preview,
            started: node.started,
            status: "unknown",
            elapsedMs: null,
          })),
      ],
      coverage: {
        recorded: nodes.filter((node) => node.source === "recorded").length,
        messages: nodes.filter((node) => node.source === "messages").length,
        gaps: data.snapshots.reduce((sum, snapshot) => sum + snapshot.gaps.length, 0),
        partial: runs.some((run) => run.recording !== "complete") || (!runs.length && !!nodes.length),
      },
      activityTotal: activities.length,
      humanInputs: activity.humanInputs,
      taskInstructions: activity.taskInstructions,
      activitySegments: activity.segments,
      lanes: (["input", "model", "tool"] as const).map((kind) => ({
        kind,
        start,
        end,
        ...(() => {
          const lane = activities.filter((node) =>
            kind === "input"
              ? node.kind === "input" || node.kind === "subtask"
              : kind === "model"
                ? node.evidenceKind === "call" || node.evidenceKind === "attempt"
                : node.kind === "tool",
          )
          return { total: lane.length, nodes: ExecutionActivity.aggregate(activities, kind) }
        })(),
      })),
    })
  }
  async function requireRoot(sessionID: string) {
    const session = await Session.get(sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new Storage.NotFoundError({ message: "Session is outside the selected Scope" })
    return session
  }
  async function data(sessionID: string) {
    const root = await requireRoot(sessionID)
    init()
    const cache = state()
    const existing = cache.entries.get(sessionID)
    if (existing && !cache.dirty.has(sessionID)) {
      existing.touched = Date.now()
      return existing
    }
    const pending = cache.pending.get(sessionID)
    if (pending) return pending
    const loading = (existing && !existing.refreshChildren ? flush(existing) : build(root))
      .then(async (value) => {
        for (;;) {
          if (
            [...cache.bufferedSessions.values()].some(
              (info) =>
                info.parentID &&
                value.sessions.some((session) => session.id === info.parentID) &&
                !value.sessions.some((session) => session.id === info.id),
            )
          ) {
            value = await build(root)
            continue
          }
          if (existing && value !== existing) value.selections = existing.selections
          const version = cache.bufferVersion
          let updated = false
          for (const info of cache.bufferedSessions.values()) {
            const index = value.sessions.findIndex((session) => session.id === info.id)
            if (index >= 0 && value.sessions[index] !== info) {
              value.sessions[index] = info
              updated = true
            }
          }
          for (const event of [...cache.buffered.values()].sort((a, b) => a.revision - b.revision))
            apply(value, event.owner, event.revision, event.record)
          if (value.refreshChildren) {
            value = await build(root)
            continue
          }
          for (const record of cache.bufferedUsage.values())
            if (
              record.owner.kind === "session" &&
              value.sessions.some(
                (session) => record.owner.kind === "session" && session.id === record.owner.sessionID,
              ) &&
              value.usage.get(record.id) !== record
            ) {
              value.usage.set(record.id, record)
              updated = true
            }
          for (const [messageID, ownerID] of cache.bufferedMessages)
            if (value.sessions.some((session) => session.id === ownerID)) value.pendingMessages.set(messageID, ownerID)
          if (updated || value.changed.size || value.pendingMessages.size) await flush(value)
          if (cache.bufferVersion === version) break
        }
        cache.entries.set(sessionID, value)
        cache.dirty.delete(sessionID)
        if (cache.entries.size > 8) {
          const oldest = [...cache.entries.values()].sort((a, b) => a.touched - b.touched)[0]
          cache.entries.delete(oldest.root.id)
        }
        return value
      })
      .finally(() => {
        cache.pending.delete(sessionID)
        if (!cache.pending.size) {
          cache.buffered.clear()
          cache.bufferedMessages.clear()
          cache.bufferedUsage.clear()
          cache.bufferedSessions.clear()
        }
      })
    cache.pending.set(sessionID, loading)
    return loading
  }
  function update<T extends { id: string }>(values: T[], value: T) {
    const index = values.findIndex((item) => item.id === value.id)
    if (index < 0) values.push(value)
    else values[index] = value
  }
  function apply(entry: Data, owner: RolloutSchema.Owner, revision: number, record: RolloutEvents.Record) {
    const snapshot = entry.snapshots.find((snapshot) => JSON.stringify(snapshot.owner) === JSON.stringify(owner))
    const session = entry.sessions.find((session) => owner.kind === "session" && session.id === owner.sessionID)
    if (!snapshot || !session || revision <= snapshot.revision) return
    if (revision !== snapshot.revision + 1) {
      entry.refreshChildren = true
      return
    }
    snapshot.revision = revision
    if (record.kind === "run") update(snapshot.runs, record.value)
    if (record.kind === "call") update(snapshot.calls, record.value)
    if (record.kind === "attempt") update(snapshot.attempts, record.value)
    if (record.kind === "segment") update(snapshot.segments, record.value)
    if (record.kind === "tool") update(snapshot.tools, record.value)
    if (record.kind === "process") update(snapshot.processes, record.value)
    const projected = nodesFor(
      {
        ...snapshot,
        runs: record.kind === "run" ? [record.value] : [],
        calls: record.kind === "call" ? [record.value] : [],
        attempts: record.kind === "attempt" ? [record.value] : [],
        tools: record.kind === "tool" ? [record.value] : [],
        processes: record.kind === "process" ? [record.value] : [],
      },
      session,
    )
    for (const node of projected.nodes) {
      const old = entry.nodes.find((item) => item.id === node.id)
      if (node.kind === "tool" && !node.preview && old?.preview) node.preview = old.preview
      if (node.kind === "tool" && old?.parentID && entry.evidence.get(old.parentID)?.record.kind === "call")
        node.parentID = old.parentID
      if (node.kind === "tool" && old?.agent) node.agent = old.agent
      update(entry.nodes, node)
      entry.changed.add(node.id)
    }
    for (const [id, value] of projected.evidence) entry.evidence.set(id, value)
  }
  async function flush(entry: Data) {
    for (const [messageID, sessionID] of entry.pendingMessages) {
      const message = await MessageV2.get({ sessionID, messageID }).catch(() => undefined)
      const old = entry.nodes.filter((node) => node.messageID === messageID && node.source === "messages")
      entry.nodes = entry.nodes.filter((node) => !(node.messageID === messageID && node.source === "messages"))
      for (const node of old) {
        entry.messages.delete(node.id)
        entry.removed.add(node.id)
      }
      if (!message) continue
      const info = MessageV2.deriveSemantics([message])[0].info
      rememberContext(entry.contexts, info)
      for (const part of message.parts) {
        if (part.type === "tool") {
          const node = entry.nodes.find(
            (node) =>
              node.kind === "tool" &&
              node.messageID === messageID &&
              entry.evidence.get(node.id)?.record.kind === "tool" &&
              (entry.evidence.get(node.id)!.record.value as RolloutSchema.ToolExecutionRecord).toolCallID ===
                part.callID,
          )
          if (node) {
            node.preview = preview(
              part.state.status === "completed" ? part.state.title : JSON.stringify(part.state.input ?? {}),
            )
            const callID = messageCall(info, message.parts, part.id)
            if (callID && entry.evidence.get(nodeID(sessionID, "call", callID))?.record.kind === "call")
              node.parentID = nodeID(sessionID, "call", callID)
            node.agent = info.agent
            entry.changed.add(node.id)
            continue
          }
        }
        const node = normalizedNode(info, part, entry.revision + 1, message.parts)
        if (!node) continue
        entry.nodes.push(node)
        entry.messages.set(node.id, { sessionID, messageID, partID: part.id })
        entry.changed.add(node.id)
        entry.removed.delete(node.id)
      }
    }
    entry.pendingMessages.clear()
    entry.nodes.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
    entry.revision = ++state().sequence
    entry.touched = Date.now()
    entry.summary = await summarize(entry)
    for (const [runID, selection] of entry.selections) {
      selection.summary = await summarize(entry, runID)
    }
    return entry
  }
  export function init() {
    const cache = state()
    if (cache.dispose) return cache.dispose
    const schedule = (sessionID: string, messageID?: string, refreshChildren = false) => {
      for (const entry of cache.entries.values()) {
        if (!entry.sessions.some((session) => session.id === sessionID)) continue
        if (messageID) entry.pendingMessages.set(messageID, sessionID)
        entry.refreshChildren ||= refreshChildren
        cache.dirty.add(entry.root.id)
        if (Date.now() - entry.touched > 600_000 || cache.timers.has(entry.root.id)) continue
        const timer = setTimeout(async () => {
          cache.timers.delete(entry.root.id)
          await ScopeContext.provide({
            scope: entry.root.scope,
            fn: async () => {
              const previousRevision = entry.publishedRevision
              const next = await data(entry.root.id)
              const process = ExecutionProcess.project(next.nodes, "process", entry.root.id)
              const processUpserts = process.filter(
                (node) =>
                  JSON.stringify({ ...node, revision: 0 }) !==
                  JSON.stringify({ ...entry.processRows.get(node.id), revision: 0 }),
              )
              const processIDs = new Set(process.map((node) => node.id))
              const processRemoved = [...entry.processRows.keys()].filter((id) => !processIDs.has(id))
              next.processRows = new Map(process.map((node) => [node.id, node]))
              const records = ExecutionProcess.project(next.nodes, "records", entry.root.id)
              const upserts = records.filter(
                (node) =>
                  JSON.stringify({ ...node, revision: 0 }) !==
                  JSON.stringify({ ...entry.recordRows.get(node.id), revision: 0 }),
              )
              next.recordRows = new Map(records.map((node) => [node.id, node]))
              const ids = new Set(next.nodes.map((node) => node.id))
              await Bus.publish(ExecutionSchema.Updated, {
                sessionID: entry.root.id,
                revision: next.revision,
                previousRevision,
                summary: next.summary,
                roundSummaries: [...next.selections.values()].map((selection) => selection.summary),
                upserts: upserts.map((node) => ({ ...node, revision: next.revision })),
                processUpserts: processUpserts.map((node) => ({ ...node, revision: next.revision })),
                processRemoved,
                removed:
                  next === entry
                    ? [...next.removed]
                    : entry.nodes.filter((node) => !ids.has(node.id)).map((node) => node.id),
              })
              next.publishedRevision = next.revision
              next.changed.clear()
              next.removed.clear()
            },
          }).catch((error) => {
            if (error instanceof Storage.NotFoundError) {
              cache.entries.delete(entry.root.id)
              cache.dirty.delete(entry.root.id)
              return
            }
            log.warn("execution snapshot update failed", { error })
            const current = cache.entries.get(entry.root.id)
            if (current) current.refreshChildren = true
            cache.dirty.add(entry.root.id)
          })
        }, 750)
        timer.unref()
        cache.timers.set(entry.root.id, timer)
      }
    }
    const disposers = [
      Bus.subscribeGlobal(RolloutEvents.Updated, (event) => {
        if (event.properties.owner.kind !== "session") return
        if (cache.pending.size) {
          cache.bufferVersion++
          cache.buffered.set(
            JSON.stringify([event.properties.owner, event.properties.record.kind, event.properties.record.value.id]),
            event.properties,
          )
        }
        for (const entry of cache.entries.values())
          apply(entry, event.properties.owner, event.properties.revision, event.properties.record)
        schedule(event.properties.owner.sessionID)
      }),
      Bus.subscribeGlobal(Usage.Updated, (event) => {
        if (event.properties.owner.kind !== "session") return
        if (cache.pending.size) {
          cache.bufferVersion++
          cache.bufferedUsage.set(event.properties.record.id, event.properties.record)
        }
        for (const entry of cache.entries.values())
          if (
            entry.sessions.some(
              (session) => event.properties.owner.kind === "session" && session.id === event.properties.owner.sessionID,
            )
          )
            entry.usage.set(event.properties.record.id, event.properties.record)
        schedule(event.properties.owner.sessionID)
      }),
      Bus.subscribeGlobal(MessageV2.Event.Updated, (event) => {
        if (cache.pending.size) {
          cache.bufferVersion++
          cache.bufferedMessages.set(event.properties.info.id, event.properties.info.sessionID)
        }
        schedule(event.properties.info.sessionID, event.properties.info.id)
      }),
      Bus.subscribeGlobal(MessageV2.Event.PartUpdated, (event) => {
        if (cache.pending.size) {
          cache.bufferVersion++
          cache.bufferedMessages.set(event.properties.part.messageID, event.properties.part.sessionID)
        }
        schedule(event.properties.part.sessionID, event.properties.part.messageID)
      }),
      Bus.subscribeGlobal(MessageV2.Event.Removed, (event) => {
        if (cache.pending.size) {
          cache.bufferVersion++
          cache.bufferedMessages.set(event.properties.messageID, event.properties.sessionID)
        }
        schedule(event.properties.sessionID, event.properties.messageID)
      }),
      Bus.subscribeGlobal(SessionEvent.Updated, (event) => {
        const info = event.properties.info
        if (cache.pending.size) {
          cache.bufferVersion++
          cache.bufferedSessions.set(info.id, info)
        }
        const unknown =
          info.parentID &&
          [...cache.entries.values()].some(
            (entry) =>
              entry.sessions.some((session) => session.id === info.parentID) &&
              !entry.sessions.some((session) => session.id === info.id),
          )
        for (const entry of cache.entries.values()) {
          const index = entry.sessions.findIndex((session) => session.id === info.id)
          if (index >= 0) entry.sessions[index] = info
        }
        schedule(info.parentID ?? info.id, undefined, !!unknown)
      }),
    ]
    cache.dispose = () => {
      for (const dispose of disposers) dispose()
      for (const timer of cache.timers.values()) clearTimeout(timer)
      cache.timers.clear()
      cache.entries.clear()
      cache.dispose = undefined
    }
    return cache.dispose
  }
  export async function summary(sessionID: string, runID?: string) {
    const value = await data(sessionID)
    if (!runID) return value.summary
    if (!value.summary.rounds.some((round) => round.id === runID))
      throw new Storage.NotFoundError({ message: "Execution round was not found" })
    const summary = await summarize(value, runID)
    value.selections.delete(runID)
    value.selections.set(runID, { summary, touched: Date.now() })
    if (value.selections.size > 4) value.selections.delete(value.selections.keys().next().value!)
    return summary
  }
  export async function trajectory(sessionID: string, input: ExecutionSchema.Query) {
    const value = await data(sessionID)
    if (input.runID && !value.summary.rounds.some((round) => round.id === input.runID))
      throw new Storage.NotFoundError({ message: "Execution round was not found" })
    if (input.session && !value.sessions.some((session) => session.id === input.session))
      throw new Storage.NotFoundError({ message: "Executor does not belong to this task" })
    const query = input.query?.trim().toLocaleLowerCase()
    const kinds = input.kinds
      ?.split(",")
      .filter(Boolean)
      .map((kind) => ExecutionSchema.Node.shape.kind.parse(kind))
    const statuses = input.statuses
      ?.split(",")
      .filter(Boolean)
      .map((status) => ExecutionSchema.Node.shape.status.parse(status))
    const actualActivities = ExecutionActivity.project(selected(value, input.runID), value.root.id).nodes
    const activityNodes = new Map(actualActivities.map((node) => [node.id, node.activity]))
    const activityPositions = new Map(actualActivities.map((node, index) => [node.id, index]))
    const rows = ExecutionProcess.project(selected(value, input.runID), input.mode, value.root.id)
      .map((node) => ({ ...node, activity: activityNodes.get(node.id) }))
      .filter(
        (node) =>
          (input.session
            ? node.sessionID === input.session
            : !!query ||
              input.actor === "all" ||
              node.sessionID === sessionID ||
              (node.kind === "subtask" &&
                value.sessions.find((session) => session.id === node.sessionID)?.parentID === sessionID)) &&
          (!input.kind || node.kind === input.kind) &&
          (!input.status || node.status === input.status) &&
          (!kinds?.length || kinds.includes(node.kind)) &&
          (!statuses?.length || statuses.includes(node.status)) &&
          (!input.anomalies || node.kind === "retry" || ["failed", "cancelled", "interrupted"].includes(node.status)) &&
          (input.activityFrom === undefined || (activityPositions.get(node.id) ?? -1) >= input.activityFrom) &&
          (input.activityTo === undefined || (activityPositions.get(node.id) ?? Infinity) <= input.activityTo) &&
          (input.from === undefined || node.started >= input.from) &&
          (input.to === undefined || node.started <= input.to) &&
          (!query ||
            (node.title + " " + node.preview + " " + (node.tool ?? "") + " " + (node.agent ?? ""))
              .toLocaleLowerCase()
              .includes(query)),
      )
    if (input.order !== "time") {
      const rounds = new Map(value.summary.rounds.map((round, index) => [round.id, index]))
      rows.sort(
        (a, b) =>
          (rounds.get(a.rootRunID ?? "") ?? Number.MAX_SAFE_INTEGER) -
            (rounds.get(b.rootRunID ?? "") ?? Number.MAX_SAFE_INTEGER) ||
          (input.order === "call" ? (a.group?.started ?? a.started) - (b.group?.started ?? b.started) : 0) ||
          a.started - b.started ||
          a.id.localeCompare(b.id),
      )
    }
    const fingerprint = JSON.stringify({
      ...input,
      cursor: undefined,
      anchor: undefined,
      position: undefined,
      limit: undefined,
    })
    let offset = 0
    if (input.cursor) {
      const parsed = z
        .object({ filter: z.string(), after: z.string().nullable(), before: z.string().nullable() })
        .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()))
      if (parsed.filter !== fingerprint) throw new Error("Trajectory cursor does not match its filters")
      if (parsed.after) offset = Math.max(0, rows.findIndex((node) => node.id === parsed.after) + 1)
      if (parsed.before) offset = Math.max(0, rows.findIndex((node) => node.id === parsed.before) - input.limit)
    } else if (input.anchor === "latest") {
      offset = Math.max(0, rows.length - input.limit)
    } else if (input.anchor) {
      const index = rows.findIndex(
        (node) => node.id === input.anchor || node.runID === input.anchor || node.messageID === input.anchor,
      )
      offset = Math.max(
        0,
        input.position === "after"
          ? index + 1
          : index - (input.position === "before" ? input.limit : Math.floor(input.limit / 2)),
      )
    }
    const items = rows.slice(offset, offset + input.limit)
    const cursor = (after: string | null, before: string | null) =>
      Buffer.from(JSON.stringify({ filter: fingerprint, after, before })).toString("base64url")
    return ExecutionSchema.Page.parse({
      sessionID,
      revision: value.revision,
      total: rows.length,
      items,
      nextCursor: offset + items.length < rows.length && items.length ? cursor(items.at(-1)!.id, null) : null,
      previousCursor: offset > 0 && items.length ? cursor(null, items[0].id) : null,
    })
  }
  async function find(sessionID: string, id: string, runID?: string) {
    const value = await data(sessionID)
    if (runID && !value.summary.rounds.some((round) => round.id === runID))
      throw new Storage.NotFoundError({ message: "Execution round was not found" })
    const node = selected(value, runID).find((node) => node.id === id)
    if (!node) throw new Storage.NotFoundError({ message: "Trajectory node was not found in this session" })
    return { value, node, evidence: value.evidence.get(id), message: value.messages.get(id) }
  }
  export async function node(sessionID: string, id: string, runID?: string, signal?: AbortSignal) {
    const found = await find(sessionID, id, runID)
    const call =
      found.evidence?.record.kind === "call"
        ? found.evidence
        : found.node.parentID
          ? found.value.evidence.get(found.node.parentID)
          : undefined
    const definitions =
      call?.record.kind === "call" && (found.node.kind === "tool" || found.evidence?.record.kind === "call")
        ? await ExecutionContent.value(
            await contentSource(
              sessionID,
              nodeID(found.node.sessionID, "call", call.record.value.id),
              "request",
              runID,
            ),
            ["tools"],
            signal,
          )
        : undefined
    const toolDefinitions =
      found.node.kind === "tool" && Array.isArray(definitions)
        ? definitions.filter(
            (definition) =>
              definition &&
              typeof definition === "object" &&
              (("id" in definition && definition.id === found.node.tool) ||
                ("name" in definition && definition.name === found.node.tool) ||
                ("function" in definition &&
                  definition.function &&
                  typeof definition.function === "object" &&
                  "name" in definition.function &&
                  definition.function.name === found.node.tool)),
          )
        : definitions
    const process = ExecutionProcess.project(found.value.nodes, "process", found.value.root.id)
    const projected =
      process.find((node) => node.id === id) ??
      ExecutionProcess.project(found.value.nodes, "records", found.value.root.id).find((node) => node.id === id) ??
      found.node
    const grouped =
      (projected.group?.callCount ?? 0) > 1 ? ExecutionProcess.auxiliaryMembers(found.value.nodes, projected) : []
    return ExecutionSchema.Detail.parse({
      node: projected,
      record: found.evidence?.record.value ?? found.message ?? null,
      sources: found.evidence ? RolloutEvidence.sources(found.evidence.record) : [],
      definitions: toolDefinitions ?? null,
      related: [
        ...new Map(
          [
            ...grouped,
            ...found.value.nodes.filter((node) => node.parentID === id || node.id === found.node.parentID),
          ].map((node) => [node.id, node]),
        ).values(),
      ].slice(0, 500),
    })
  }
  export async function content(
    sessionID: string,
    id: string,
    field: string,
    offset: number,
    limit: number,
    runID?: string,
    version?: string,
  ) {
    return (await contentSource(sessionID, id, field, runID, version)).read(offset, limit)
  }
  export async function contentSource(
    sessionID: string,
    id: string,
    field: string,
    runID?: string,
    version?: string,
  ): Promise<ExecutionContent.Source> {
    const found = await find(sessionID, id, runID)
    if (found.evidence) {
      const { owner, record } = found.evidence
      const { ref, contentVersion } = await RolloutEvidence.source(owner, record, field, version)
      return {
        ...ref,
        contentVersion,
        read: (offset, limit) => RolloutEvidence.content(owner, record, field, offset, limit, contentVersion),
        stream: async function* () {
          yield* (await RolloutEvidence.stream(owner, record, field, contentVersion)).chunks
        },
      }
    }
    if (field !== "message") throw new Storage.NotFoundError({ message: "Message content field was not found" })
    const message =
      found.message && (await MessageV2.get({ sessionID: found.message.sessionID, messageID: found.message.messageID }))
    const text = JSON.stringify(
      message && { info: message.info, part: message.parts.find((part) => part.id === found.message!.partID) },
      null,
      2,
    )
    if (!text) throw new Storage.NotFoundError({ message: "Message content was not found" })
    const bytes = Buffer.from(text)
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const contentVersion = "message:" + id + ":" + sha256
    if (version && version !== contentVersion) throw new RangeError("Execution message version changed")
    return {
      mediaType: "application/json",
      bytes: bytes.length,
      status: "complete",
      sha256,
      contentVersion,
      read: async (offset, limit) => {
        z.number().int().nonnegative().safe().parse(offset)
        z.number().int().min(1).max(65_536).parse(limit)
        if (offset > bytes.length) throw new RangeError("Content offset exceeds the recorded message")
        const end = offset + RolloutEvidence.textBoundary(bytes.subarray(offset, offset + limit + 4), limit)
        return ExecutionSchema.Content.parse({
          mediaType: "application/json",
          text: bytes.subarray(offset, end).toString(),
          offset,
          nextOffset: end < bytes.length ? end : null,
          bytes: bytes.length,
          status: "complete",
          contentVersion,
          sha256,
        })
      },
      stream: async function* () {
        for (let offset = 0; offset < bytes.length; offset += 65_536) yield bytes.subarray(offset, offset + 65_536)
      },
    }
  }
}
