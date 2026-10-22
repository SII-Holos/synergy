import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { z } from "zod"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { reconcileContextUsage } from "@ericsanchezok/synergy-harness/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import {
  RolloutAccounting,
  RolloutExecution,
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
import { ExecutionQueryError, queryCursor, queryValue } from "./query"
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
    nodePositions: Map<string, number>
    sessionsByID: Map<string, Session.Info>
    snapshotsByID: Map<string, RolloutSnapshot.Info>
    evidence: Map<string, Evidence>
    messages: Map<string, { sessionID: string; messageID: string; partID: string }>
    usage: Map<string, UsageSchema.Record>
    contexts: Map<string, NonNullable<MessageV2.Assistant["contextUsage"]>>
    inboxes: Map<string, SessionInbox.Item[]>
    revision: number
    summary: ExecutionSchema.Summary
    touched: number
    pendingMessages: Map<string, string>
    changed: Set<string>
    removed: Set<string>
    refreshOwners: Set<string>
    addedSessions: Map<string, Session.Info>
    changes: Changes
    selections: Map<string, { summary: ExecutionSchema.Summary; touched: number }>
    processRows: Map<string, ExecutionSchema.Node>
    recordRows: Map<string, ExecutionSchema.Node>
    contextRows: Map<string, string>
    publishedRevision: number
  }
  type Changes = {
    owners: Set<string>
    events: Map<string, { ownerID: string; apply: (entry: Data) => void }>
    repair: Set<string>
  }
  type Loading = {
    scopeID: string
    promise: Promise<Data>
    changes: Changes
    controller: AbortController
    readers: number
  }
  const changesFor = (ids: Iterable<string>): Changes => ({
    owners: new Set(ids),
    events: new Map(),
    repair: new Set(),
  })
  function enqueue(changes: Changes, ownerID: string, key: string, apply: (entry: Data) => void) {
    if (changes.repair.has(ownerID)) return
    if (changes.events.size >= 4096) {
      changes.repair.add(ownerID)
      for (const [id, event] of changes.events) if (event.ownerID === ownerID) changes.events.delete(id)
      return
    }
    changes.events.set(key, { ownerID, apply })
  }
  function checkpoint(signal?: AbortSignal) {
    signal?.throwIfAborted()
  }
  const state = RuntimeContext.state(() => ({
    entries: new Map<string, Data>(),
    subscriptions: new Map<string, number>(),
    legacyClients: 0,
    pending: new Map<string, Loading>(),
    timers: new Map<string, ReturnType<typeof setTimeout>>(),
    dirty: new Set<string>(),
    sequence: 0,
    schedule: undefined as ((sessionID: string) => void) | undefined,
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
      if (
        record.kind === "segment" ||
        record.kind === "interval" ||
        (record.kind === "run" && record.value.admissionOnly)
      )
        return
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
        status: record.kind === "run" ? (record.value.execution?.status ?? value.status) : value.status,
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
  function messageCalls(info: MessageV2.Info, parts: MessageV2.Part[]) {
    const calls = new Map<string, string>()
    if (info.role !== "assistant") return calls
    const fallback =
      info.accounting?.kind === "rollout" && info.accounting.callIDs.length === 1
        ? info.accounting.callIDs[0]
        : undefined
    let next: string | undefined
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index]
      const call = next ?? fallback
      if (call) calls.set(part.id, call)
      if (part.type === "step-start") next = undefined
      if (part.type === "step-finish")
        next =
          part.accounting?.kind === "rollout" && part.accounting.callIDs.length === 1
            ? part.accounting.callIDs[0]
            : undefined
    }
    return calls
  }
  function normalizedNode(info: MessageV2.Info, part: MessageV2.Part, revision: number, callID?: string) {
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
        : tool.state.status === "pending" || tool.state.status === "generating"
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
  function rememberContext(contexts: Data["contexts"], info: MessageV2.Info, changed?: Set<string>) {
    if (info.role !== "assistant" || !info.contextUsage || info.accounting?.kind !== "rollout") return
    const callID = info.contextUsage.callID ?? info.accounting.callIDs.at(-1)
    if (callID && info.accounting.callIDs.includes(callID)) {
      contexts.set(callID, info.contextUsage)
      changed?.add(nodeID(info.sessionID, "call", callID))
    }
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
  async function build(
    root: Session.Info,
    changes = changesFor([root.id]),
    signal?: AbortSignal,
    descendants = true,
  ): Promise<Data> {
    checkpoint(signal)
    ObservabilityMetrics.record({
      name: descendants ? "execution.tree.build" : "execution.owner.build",
      value: 1,
      unit: "count",
      module: "session",
    })
    const sessions = [root]
    const seen = new Set([root.id])
    for (let index = 0; descendants && index < sessions.length; index++) {
      checkpoint(signal)
      for (const child of await Session.children(sessions[index].id)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        changes.owners.add(child.id)
        sessions.push(child)
      }
    }
    checkpoint(signal)
    const snapshots = await ObservabilitySpans.measure(
      { name: "execution.snapshot", module: "session", kind: "session" },
      () =>
        RolloutSnapshot.currentAll(
          sessions.map((session) => ({
            kind: "session",
            scopeID: session.scope.id,
            sessionID: session.id,
          })),
          signal,
        ),
    )
    const nodes: ExecutionSchema.Node[] = []
    const evidence = new Map<string, Evidence>()
    const messages = new Map<string, { sessionID: string; messageID: string; partID: string }>()
    const contexts: Data["contexts"] = new Map()
    for (const [index, session] of sessions.entries()) {
      checkpoint(signal)
      const snapshot = snapshots[index]
      const projected = nodesFor(snapshot, session)
      nodes.push(...projected.nodes)
      for (const [key, value] of projected.evidence) evidence.set(key, value)
      const raw: MessageV2.WithParts[] = []
      await ObservabilitySpans.measure({ name: "execution.messages", module: "session", kind: "session" }, async () => {
        for await (const message of MessageV2.stream({ sessionID: session.id })) {
          checkpoint(signal)
          raw.push(message)
        }
      })
      const tools = toolIndex(projected.nodes, evidence)
      let processed = 0
      for (const message of MessageV2.deriveSemantics(raw.toReversed())) {
        rememberContext(contexts, message.info)
        const calls = messageCalls(message.info, message.parts)
        for (const part of message.parts) {
          if (++processed % 256 === 0) {
            await Bun.sleep(0)
            checkpoint(signal)
          }
          if (part.type === "tool") {
            const tool = tools.get(JSON.stringify([session.id, message.info.id, part.callID]))
            if (tool) {
              tool.preview = preview(
                part.state.status === "completed" ? part.state.title : JSON.stringify(part.state.input ?? {}),
              )
              const callID = calls.get(part.id)
              if (callID && evidence.get(nodeID(session.id, "call", callID))?.record.kind === "call")
                tool.parentID = nodeID(session.id, "call", callID)
              tool.agent = message.info.agent
              continue
            }
          }
          const node = normalizedNode(message.info, part, 0, calls.get(part.id))
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
      async () =>
        (
          await Promise.all(
            sessions.map((session) =>
              Usage.collect({ scopeID: session.scope.id, sessionID: session.id, includeDescendants: false }),
            ),
          )
        ).flat(),
    ))
      usage.set(record.id, record)
    const inboxes = new Map(
      await Promise.all(sessions.map(async (session) => [session.id, await SessionInbox.list(session.id)] as const)),
    )
    const revision = ++state().sequence
    const data = {
      root,
      sessions,
      snapshots,
      nodes,
      evidence,
      messages,
      nodePositions: new Map(nodes.map((node, index) => [node.id, index])),
      sessionsByID: new Map(sessions.map((session) => [session.id, session])),
      snapshotsByID: new Map(
        snapshots.map((snapshot) => [snapshot.owner.kind === "session" ? snapshot.owner.sessionID : "", snapshot]),
      ),
      usage,
      contexts,
      inboxes,
      revision,
      touched: Date.now(),
      pendingMessages: new Map<string, string>(),
      changed: new Set<string>(),
      removed: new Set<string>(),
      refreshOwners: new Set<string>(),
      addedSessions: new Map<string, Session.Info>(),
      changes,
      selections: new Map<string, { summary: ExecutionSchema.Summary; touched: number }>(),
      processRows: new Map(ExecutionProcess.project(nodes, "process", root.id).map((node) => [node.id, node])),
      recordRows: new Map(ExecutionProcess.project(nodes, "records", root.id).map((node) => [node.id, node])),
      contextRows: new Map<string, string>(),
      publishedRevision: revision,
    } as Omit<Data, "summary">
    const value = { ...data, summary: summarize(data) }
    value.contextRows = new Map(contextSnapshots(value).map((context) => [context.nodeID, JSON.stringify(context)]))
    return value
  }
  function summarize(data: Omit<Data, "summary">, runID?: string): ExecutionSchema.Summary {
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
      intervals: snapshot.intervals.filter((interval) =>
        identities.has((snapshot.owner.kind === "session" ? snapshot.owner.sessionID : "") + ":" + interval.runID),
      ),
      attempts: snapshot.attempts.filter((attempt) =>
        identities.has((snapshot.owner.kind === "session" ? snapshot.owner.sessionID : "") + ":" + attempt.runID),
      ),
    }))
    const sample = RolloutExecution.clock()
    const projection = (scope: RolloutSnapshot.Info[], rootRuns = scope[0].runs, selectedRunID?: string) =>
      RolloutExecution.summarize(
        {
          roots: rootRuns,
          runs: scope.flatMap((snapshot) => snapshot.runs),
          intervals: scope.flatMap((snapshot) => snapshot.intervals),
          segments: scope.flatMap((snapshot) => snapshot.segments),
          hasHistory: nodes.some(
            (node) =>
              scope.some(
                (snapshot) => snapshot.owner.kind === "session" && snapshot.owner.sessionID === node.sessionID,
              ) &&
              (!selectedRunID || node.rootRunID === selectedRunID || node.runID === selectedRunID) &&
              ["output", "model", "tool"].includes(node.kind),
          ),
          paused: data.sessions.some((candidate) => {
            if (!candidate.paused) return false
            const selected = scope.find(
              (snapshot) => snapshot.owner.kind === "session" && snapshot.owner.sessionID === candidate.id,
            )
            if (!selected) return false
            if (!selectedRunID && !runID) return true
            const latest = data.snapshots
              .find((snapshot) => snapshot.owner.kind === "session" && snapshot.owner.sessionID === candidate.id)
              ?.runs.filter((run) => !run.admissionOnly)
              .toSorted((a, b) => b.started - a.started || b.id.localeCompare(a.id))[0]
            return (
              !!latest &&
              ["running", "interrupted"].includes(latest.execution?.status ?? latest.status) &&
              selected.runs.some((run) => run.id === latest.id)
            )
          }),
          queued: data.sessions.some(
            (candidate) =>
              scope.some(
                (snapshot) => snapshot.owner.kind === "session" && snapshot.owner.sessionID === candidate.id,
              ) &&
              ((!selectedRunID && candidate.cortex?.status === "queued") ||
                (data.inboxes.get(candidate.id) ?? []).some(
                  (item) =>
                    item.mode === "task" && !item.status && (!selectedRunID || item.messageID === selectedRunID),
                )),
          ),
        },
        sample,
      )
    const subtree = (sessionID: string) => {
      const ids = new Set([sessionID])
      for (let size = -1; size !== ids.size;) {
        size = ids.size
        for (const session of data.sessions) if (session.parentID && ids.has(session.parentID)) ids.add(session.id)
      }
      return snapshots.filter((snapshot) => snapshot.owner.kind === "session" && ids.has(snapshot.owner.sessionID))
    }
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
      clockID: sample.clockID,
      sampledAt: sample.now,
      ...projection(snapshots, roots, runID),
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
          ...projection(subtree(session.id), snapshots[index + 1].runs),
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
        ...data.snapshots[0].runs
          .filter((run) => !run.admissionOnly)
          .map((run) => {
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
              ...projection(
                data.snapshots.map((snapshot) => ({
                  ...snapshot,
                  runs: snapshot.runs.filter(
                    (candidate) =>
                      snapshot.owner.kind === "session" &&
                      roundIdentities.has(snapshot.owner.sessionID + ":" + candidate.id),
                  ),
                  intervals: snapshot.intervals.filter(
                    (interval) =>
                      snapshot.owner.kind === "session" &&
                      roundIdentities.has(snapshot.owner.sessionID + ":" + interval.runID),
                  ),
                })),
                [run],
                run.id,
              ),
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
            elapsedMs: 0,
            elapsedActive: false,
            elapsedLowerBound: true,
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
  function cancelUnused(sessionID: string, loading: Loading) {
    const cache = state()
    if (!loading.readers && !cache.subscriptions.has(sessionID) && !cache.legacyClients) loading.controller.abort()
  }
  async function consume(sessionID: string, loading: Loading, signal?: AbortSignal) {
    checkpoint(signal)
    loading.readers++
    let abort: (() => void) | undefined
    try {
      if (!signal) return await loading.promise
      return await Promise.race([
        loading.promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
        }),
      ])
    } finally {
      if (abort) signal?.removeEventListener("abort", abort)
      loading.readers--
      cancelUnused(sessionID, loading)
    }
  }
  async function repair(entry: Data, signal?: AbortSignal) {
    const owners = [...entry.refreshOwners]
    entry.refreshOwners.clear()
    const added = [...entry.addedSessions.values()]
    entry.addedSessions.clear()
    const sessions = new Map(added.map((info) => [info.id, info]))
    for (const id of owners) sessions.set(id, await requireRoot(id))
    const repaired = new Set<string>()
    for (const session of sessions.values()) {
      if (repaired.has(session.id)) continue
      checkpoint(signal)
      const branch = await build(session, entry.changes, signal, !owners.includes(session.id))
      const replaced = new Set(branch.sessions.map((item) => item.id))
      for (const id of replaced) repaired.add(id)
      for (const node of entry.nodes)
        if (replaced.has(node.sessionID)) {
          entry.evidence.delete(node.id)
          entry.messages.delete(node.id)
          entry.removed.add(node.id)
        }
      entry.nodes = entry.nodes.filter((node) => !replaced.has(node.sessionID))
      for (const [index, info] of branch.sessions.entries()) {
        const position = entry.sessions.findIndex((item) => item.id === info.id)
        if (position < 0) {
          entry.sessions.push(info)
          entry.snapshots.push(branch.snapshots[index])
        } else {
          entry.sessions[position] = info
          entry.snapshots[position] = branch.snapshots[index]
        }
      }
      for (const [id, record] of entry.usage)
        if (record.owner.kind === "session" && replaced.has(record.owner.sessionID)) entry.usage.delete(id)
      for (const node of branch.nodes) {
        entry.nodes.push(node)
        entry.changed.add(node.id)
        entry.removed.delete(node.id)
      }
      for (const [id, value] of branch.evidence) entry.evidence.set(id, value)
      for (const [id, value] of branch.messages) entry.messages.set(id, value)
      for (const [id, value] of branch.usage) entry.usage.set(id, value)
      for (const [id, value] of branch.contexts) entry.contexts.set(id, value)
      for (const [id, value] of branch.inboxes) entry.inboxes.set(id, value)
    }
  }
  async function data(sessionID: string, access = true, signal?: AbortSignal): Promise<Data> {
    checkpoint(signal)
    const shared = state().pending.get(sessionID)
    if (shared && shared.scopeID === ScopeContext.current.scope.id) {
      if (!shared.controller.signal.aborted) return consume(sessionID, shared, signal)
      await consume(sessionID, shared, signal).catch(() => checkpoint(signal))
      return data(sessionID, access, signal)
    }
    const root = await requireRoot(sessionID)
    checkpoint(signal)
    init()
    const cache = state()
    const existing = cache.entries.get(sessionID)
    if (existing && access) existing.touched = Date.now()
    const pending = cache.pending.get(sessionID)
    if (pending) {
      if (!pending.controller.signal.aborted) return consume(sessionID, pending, signal)
      await consume(sessionID, pending, signal).catch(() => checkpoint(signal))
      return data(sessionID, access, signal)
    }
    if (existing && !cache.dirty.has(sessionID)) return existing
    const changes = existing?.changes ?? changesFor([sessionID])
    const controller = new AbortController()
    const loading: Loading = {
      scopeID: root.scope.id,
      changes,
      controller,
      readers: 0,
      promise: Promise.resolve()
        .then(async () => {
          const value = existing ?? (await build(root, changes, controller.signal))
          checkpoint(controller.signal)
          // Detach a finite revision cut; arrivals during reads belong to the next refresh.
          const events = changes.events
          const repairs = changes.repair
          changes.events = new Map()
          changes.repair = new Set()
          let applied = 0
          for (const event of events.values()) {
            event.apply(value)
            if (++applied % 256 === 0) {
              await Bun.sleep(0)
              checkpoint(controller.signal)
            }
          }
          for (const owner of repairs) value.refreshOwners.add(owner)
          await repair(value, controller.signal)
          if (existing || events.size || repairs.size) await flush(value, controller.signal)
          checkpoint(controller.signal)
          cache.entries.set(sessionID, value)
          if (changes.events.size || changes.repair.size) cache.dirty.add(sessionID)
          else cache.dirty.delete(sessionID)
          if (cache.entries.size > 8) {
            const oldest = [...cache.entries.values()]
              .filter((entry) => !cache.pending.has(entry.root.id))
              .sort((a, b) => a.touched - b.touched)[0]
            if (oldest) {
              cache.entries.delete(oldest.root.id)
              cache.dirty.delete(oldest.root.id)
              clearTimeout(cache.timers.get(oldest.root.id))
              cache.timers.delete(oldest.root.id)
            }
          }
          return value
        })
        .catch((error) => {
          for (const owner of changes.owners) changes.repair.add(owner)
          cache.dirty.add(sessionID)
          throw error
        })
        .finally(() => {
          cache.pending.delete(sessionID)
          if (cache.dirty.has(sessionID)) cache.schedule?.(sessionID)
        }),
    }
    cache.pending.set(sessionID, loading)
    return consume(sessionID, loading, signal)
  }
  function toolIndex(nodes: ExecutionSchema.Node[], evidence: Data["evidence"]) {
    const result = new Map<string, ExecutionSchema.Node>()
    for (const node of nodes) {
      const record = evidence.get(node.id)?.record
      if (record?.kind === "tool")
        result.set(JSON.stringify([node.sessionID, record.value.messageID, record.value.toolCallID]), node)
    }
    return result
  }
  function update<T extends { id: string }>(values: T[], value: T) {
    const index = values.findIndex((item) => item.id === value.id)
    if (index < 0) values.push(value)
    else values[index] = value
  }
  function apply(entry: Data, owner: RolloutSchema.Owner, revision: number, record: RolloutEvents.Record) {
    if (owner.kind !== "session") return
    const snapshot = entry.snapshotsByID.get(owner.sessionID)
    const session = entry.sessionsByID.get(owner.sessionID)
    if (!snapshot || !session || revision <= snapshot.revision) return
    if (revision !== snapshot.revision + 1) {
      entry.refreshOwners.add(session.id)
      return
    }
    snapshot.revision = revision
    if (record.kind === "run") update(snapshot.runs, record.value)
    if (record.kind === "call") update(snapshot.calls, record.value)
    if (record.kind === "attempt") update(snapshot.attempts, record.value)
    if (record.kind === "segment") update(snapshot.segments, record.value)
    if (record.kind === "interval") {
      update(snapshot.intervals, record.value)
      entry.changed.add(nodeID(session.id, "run", record.value.runID))
    }
    if (record.kind === "run" && record.value.admissionOnly) {
      const id = nodeID(session.id, "run", record.value.id)
      entry.nodes = entry.nodes.filter((node) => node.id !== id)
      entry.evidence.delete(id)
      entry.nodePositions = new Map(entry.nodes.map((node, index) => [node.id, index]))
      entry.removed.add(id)
    }
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
      const position = entry.nodePositions.get(node.id)
      const old = position === undefined ? undefined : entry.nodes[position]
      if (node.kind === "tool" && !node.preview && old?.preview) node.preview = old.preview
      if (node.kind === "tool" && old?.parentID && entry.evidence.get(old.parentID)?.record.kind === "call")
        node.parentID = old.parentID
      if (node.kind === "tool" && old?.agent) node.agent = old.agent
      if (position === undefined) {
        entry.nodePositions.set(node.id, entry.nodes.length)
        entry.nodes.push(node)
      } else entry.nodes[position] = node
      entry.changed.add(node.id)
    }
    for (const [id, value] of projected.evidence) entry.evidence.set(id, value)
  }
  async function flush(entry: Data, signal?: AbortSignal) {
    const messages = entry.pendingMessages
    entry.pendingMessages = new Map()
    const tools = toolIndex(entry.nodes, entry.evidence)
    entry.nodes = entry.nodes.filter((node) => {
      if (node.source !== "messages" || !node.messageID || !messages.has(node.messageID)) return true
      entry.messages.delete(node.id)
      entry.removed.add(node.id)
      return false
    })
    let processed = 0
    for (const [messageID, sessionID] of messages) {
      checkpoint(signal)
      const message = await MessageV2.get({ sessionID, messageID }).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (!message) continue
      const info = MessageV2.deriveSemantics([message])[0].info
      rememberContext(entry.contexts, info, entry.changed)
      const calls = messageCalls(info, message.parts)
      for (const part of message.parts) {
        if (++processed % 256 === 0) {
          await Bun.sleep(0)
          checkpoint(signal)
        }
        if (part.type === "tool") {
          const node = tools.get(JSON.stringify([sessionID, messageID, part.callID]))
          if (node) {
            node.preview = preview(
              part.state.status === "completed" ? part.state.title : JSON.stringify(part.state.input ?? {}),
            )
            const callID = calls.get(part.id)
            if (callID && entry.evidence.get(nodeID(sessionID, "call", callID))?.record.kind === "call")
              node.parentID = nodeID(sessionID, "call", callID)
            node.agent = info.agent
            entry.changed.add(node.id)
            continue
          }
        }
        const node = normalizedNode(info, part, entry.revision + 1, calls.get(part.id))
        if (!node) continue
        entry.nodes.push(node)
        entry.messages.set(node.id, { sessionID, messageID, partID: part.id })
        entry.changed.add(node.id)
        entry.removed.delete(node.id)
      }
    }
    checkpoint(signal)
    entry.nodes.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
    entry.nodePositions = new Map(entry.nodes.map((node, index) => [node.id, index]))
    entry.sessionsByID = new Map(entry.sessions.map((session) => [session.id, session]))
    entry.snapshotsByID = new Map(
      entry.snapshots.map((snapshot) => [snapshot.owner.kind === "session" ? snapshot.owner.sessionID : "", snapshot]),
    )
    entry.revision = ++state().sequence
    entry.summary = summarize(entry)
    for (const [runID, selection] of entry.selections) {
      selection.summary = summarize(entry, runID)
    }
    return entry
  }
  export function subscribe(sessionID: string) {
    const cache = state()
    cache.subscriptions.set(sessionID, (cache.subscriptions.get(sessionID) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (cache.subscriptions.get(sessionID) ?? 1) - 1
      if (count) cache.subscriptions.set(sessionID, count)
      else {
        cache.subscriptions.delete(sessionID)
        const loading = cache.pending.get(sessionID)
        if (loading) cancelUnused(sessionID, loading)
        if (!cache.legacyClients) {
          clearTimeout(cache.timers.get(sessionID))
          cache.timers.delete(sessionID)
        }
      }
    }
  }
  export function legacyClient() {
    const cache = state()
    cache.legacyClients++
    let released = false
    return () => {
      if (released) return
      released = true
      cache.legacyClients--
      for (const [sessionID, loading] of cache.pending) cancelUnused(sessionID, loading)
      if (!cache.legacyClients)
        for (const [sessionID, timer] of cache.timers)
          if (!cache.subscriptions.has(sessionID)) {
            clearTimeout(timer)
            cache.timers.delete(sessionID)
          }
    }
  }
  export function init() {
    const cache = state()
    if (cache.dispose) return cache.dispose
    const schedule = (sessionID: string) => {
      for (const entry of cache.entries.values()) {
        if (!entry.changes.owners.has(sessionID)) continue
        cache.dirty.add(entry.root.id)
        if (!cache.subscriptions.has(entry.root.id) && !cache.legacyClients) continue
        if (
          (!cache.subscriptions.has(entry.root.id) && Date.now() - entry.touched > 600_000) ||
          cache.timers.has(entry.root.id)
        )
          continue
        const timer = setTimeout(async () => {
          cache.timers.delete(entry.root.id)
          if (!cache.subscriptions.has(entry.root.id) && !cache.legacyClients) return
          await ScopeContext.provide({
            scope: entry.root.scope,
            fn: async () => {
              const previousRevision = entry.publishedRevision
              const next = await data(entry.root.id, false)
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
              const contexts = contextSnapshots(next).filter(
                (context) =>
                  (next !== entry || next.changed.has(context.nodeID)) &&
                  JSON.stringify(context) !== next.contextRows.get(context.nodeID),
              )
              await Bus.publish(ExecutionSchema.Updated, {
                sessionID: entry.root.id,
                revision: next.revision,
                previousRevision,
                summary: next.summary,
                roundSummaries: [...next.selections.values()].map((selection) => selection.summary),
                contextUpserts: contexts,
                upserts: upserts.map((node) => ({ ...node, revision: next.revision })),
                processUpserts: processUpserts.map((node) => ({ ...node, revision: next.revision })),
                processRemoved,
                removed:
                  next === entry
                    ? [...next.removed]
                    : entry.nodes.filter((node) => !ids.has(node.id)).map((node) => node.id),
              })
              for (const context of contexts) next.contextRows.set(context.nodeID, JSON.stringify(context))
              for (const id of next.contextRows.keys()) if (!ids.has(id)) next.contextRows.delete(id)
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
            if (current) for (const owner of current.changes.owners) current.changes.repair.add(owner)
            cache.dirty.add(entry.root.id)
          })
        }, 750)
        timer.unref()
        cache.timers.set(entry.root.id, timer)
      }
    }
    cache.schedule = schedule
    const deliver = (ownerID: string, key: string, apply: (entry: Data) => void, parentID?: string) => {
      const buffers = new Set<Changes>([
        ...[...cache.entries.values()].map((entry) => entry.changes),
        ...[...cache.pending.values()].map((loading) => loading.changes),
      ])
      for (const changes of buffers) {
        if (parentID && changes.owners.has(parentID)) changes.owners.add(ownerID)
        if (!changes.owners.has(ownerID)) continue
        enqueue(changes, ownerID, key, apply)
      }
      schedule(parentID ?? ownerID)
    }
    const message = (sessionID: string, messageID: string) =>
      deliver(sessionID, "message:" + messageID, (entry) => entry.pendingMessages.set(messageID, sessionID))
    const disposers = [
      Bus.subscribeGlobal(RolloutEvents.Updated, (event) => {
        const { owner, revision, record } = event.properties
        if (owner.kind !== "session") return
        deliver(owner.sessionID, `rollout:${owner.sessionID}:${revision}`, (entry) =>
          apply(entry, owner, revision, record),
        )
      }),
      Bus.subscribeGlobal(SessionInbox.Event.Updated, (event) => {
        const { sessionID, items } = event.properties
        deliver(sessionID, "inbox:" + sessionID, (entry) => entry.inboxes.set(sessionID, items))
      }),
      Bus.subscribeGlobal(Usage.Updated, (event) => {
        const { owner, record } = event.properties
        if (owner.kind !== "session") return
        deliver(owner.sessionID, "usage:" + record.id, (entry) => {
          entry.usage.set(record.id, record)
          if (record.kind === "call" || record.kind === "attempt")
            entry.changed.add(nodeID(owner.sessionID, "call", record.kind === "call" ? record.entityID : record.callID))
        })
      }),
      Bus.subscribeGlobal(MessageV2.Event.Updated, (event) =>
        message(event.properties.info.sessionID, event.properties.info.id),
      ),
      Bus.subscribeGlobal(MessageV2.Event.PartUpdated, (event) =>
        message(event.properties.part.sessionID, event.properties.part.messageID),
      ),
      Bus.subscribeGlobal(MessageV2.Event.Removed, (event) =>
        message(event.properties.sessionID, event.properties.messageID),
      ),
      Bus.subscribeGlobal(SessionEvent.Updated, (event) => {
        const info = event.properties.info
        deliver(
          info.id,
          "session:" + info.id,
          (entry) => {
            const index = entry.sessions.findIndex((session) => session.id === info.id)
            if (index >= 0) {
              const previous = entry.sessions[index]
              const title = info.cortex?.description ?? info.title
              if (title !== (previous.cortex?.description ?? previous.title))
                for (const node of entry.nodes)
                  if (node.sessionID === info.id && (node.kind === "turn" || node.kind === "subtask")) {
                    node.title = title
                    entry.changed.add(node.id)
                  }
              entry.sessions[index] = info
              entry.sessionsByID.set(info.id, info)
            } else entry.addedSessions.set(info.id, info)
            if (info.id === entry.root.id) entry.root = info
          },
          info.parentID,
        )
      }),
    ]
    cache.dispose = () => {
      for (const dispose of disposers) dispose()
      for (const timer of cache.timers.values()) clearTimeout(timer)
      cache.timers.clear()
      for (const loading of cache.pending.values()) loading.controller.abort()
      cache.schedule = undefined
      cache.entries.clear()
      cache.subscriptions.clear()
      cache.legacyClients = 0
      cache.dispose = undefined
    }
    return cache.dispose
  }
  function contextSnapshots(
    value: Pick<Data, "root" | "usage" | "contexts"> & {
      snapshots: Pick<RolloutSnapshot.Info, "owner" | "runs" | "calls">[]
    },
    runID?: string,
  ): ExecutionSchema.ContextSnapshot[] {
    const snapshot = value.snapshots.find(
      (entry) => entry.owner.kind === "session" && entry.owner.sessionID === value.root.id,
    )
    if (!snapshot) return []
    const records = new Map<string, UsageSchema.Record[]>()
    for (const record of value.usage.values()) {
      const id = record.kind === "call" ? record.entityID : record.kind === "attempt" ? record.callID : undefined
      if (!id) continue
      const group = records.get(id) ?? []
      group.push(record)
      records.set(id, group)
    }
    let previous = -Infinity
    const rounds = new Map<string, number>()
    const compactions = snapshot.calls.filter((call) => call.usageRole === "compaction" && call.status === "completed")
    return snapshot.calls
      .filter((call) => call.usageRole === "conversation")
      .sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
      .map((call, index) => {
        if (!rounds.has(call.runID)) rounds.set(call.runID, rounds.size + 1)
        const candidate = value.contexts.get(call.id)
        const accounting = Usage.summarize(records.get(call.id) ?? [], {
          sessionID: value.root.id,
          includeDescendants: false,
        })
        const context = accounting.context
        const attempt = (records.get(call.id) ?? []).find(
          (entry) => entry.kind === "attempt" && entry.entityID === context?.attemptID,
        )
        const measured = attempt?.kind === "attempt" ? attempt.usage : undefined
        const estimate =
          call.contextEstimate?.modelID === call.model.modelID &&
          call.contextEstimate.providerID === call.model.providerID
            ? call.contextEstimate
            : undefined
        const usage =
          candidate &&
          candidate.providerID === call.model.providerID &&
          candidate.modelID === call.model.modelID &&
          (context?.inputTokens == null || candidate.totalInput === context.inputTokens)
            ? candidate
            : estimate && context?.inputTokens != null
              ? reconcileContextUsage(estimate, context.inputTokens, estimate.capturedAt)
              : null
        const result = {
          sessionID: value.root.id,
          callID: call.id,
          nodeID: nodeID(value.root.id, "call", call.id),
          runID: call.runID,
          started: call.started,
          requestNumber: index + 1,
          roundNumber: rounds.get(call.runID)!,
          status: call.status,
          modelID: call.model.modelID,
          providerID: call.model.providerID,
          inputTokens: usage?.totalInput ?? context?.inputTokens ?? null,
          contextLimit:
            usage?.usableInputLimit ??
            usage?.contextLimit ??
            estimate?.usableInputLimit ??
            estimate?.contextLimit ??
            (ModelLimit.usableInput(call.model.limits) || null),
          outputTokens: measured?.output.total ?? null,
          cacheHit:
            measured?.input.total && measured.input.cacheRead != null
              ? Math.min(1, measured.input.cacheRead / measured.input.total)
              : null,
          elapsedMs: call.ended == null ? null : Math.max(0, call.ended - call.started),
          retries: accounting.outcomes.retries,
          usage,
          estimate,
          compactedBefore: compactions.some(
            (entry) => (entry.ended ?? entry.started) > previous && (entry.ended ?? entry.started) <= call.started,
          ),
          requestAvailable: !!call.request,
        }
        previous = call.started
        return result
      })
      .filter((entry) => !runID || entry.runID === runID)
      .reverse()
  }
  function contextPosition(cursor: string | undefined, identity: string) {
    if (!cursor) return undefined
    const parsed = queryCursor(z.object({ identity: z.string(), id: z.string() }), cursor)
    if (parsed.identity !== identity) throw new ExecutionQueryError("Context cursor does not match this selection")
    return parsed.id
  }
  const contextCursor = (identity: string, id: string) =>
    Buffer.from(JSON.stringify({ identity, id })).toString("base64url")
  async function contextData(sessionID: string, signal?: AbortSignal) {
    checkpoint(signal)
    const root = await requireRoot(sessionID)
    const snapshot = await RolloutSnapshot.modelCalls({ kind: "session", scopeID: root.scope.id, sessionID })
    checkpoint(signal)
    const [records, infos] = await Promise.all([
      Usage.collect({ scopeID: root.scope.id, sessionID, includeDescendants: false }),
      MessageV2.readInfoList({
        scopeID: Identifier.asScopeID(root.scope.id),
        sessionID: Identifier.asSessionID(sessionID),
      }),
    ])
    checkpoint(signal)
    const contexts: Data["contexts"] = new Map()
    for (const info of infos) rememberContext(contexts, info)
    return {
      root,
      snapshots: [snapshot],
      usage: new Map(records.map((record) => [record.id, record])),
      contexts,
      revision: ++state().sequence,
    }
  }
  export async function contextHistory(
    sessionID: string,
    input: z.infer<typeof ExecutionSchema.ContextQuery>,
    signal?: AbortSignal,
  ) {
    const value = await contextData(sessionID, signal)
    const identity = JSON.stringify([ScopeContext.current.scope.id, sessionID, input.runID ?? null])
    if (input.runID && !value.snapshots[0].runs.some((run) => !run.admissionOnly && run.id === input.runID))
      throw new Storage.NotFoundError({ message: "Context round was not found" })
    const entries = contextSnapshots(value, input.runID)
    const id = contextPosition(input.cursor, identity)
    const position = id ? entries.findIndex((entry) => entry.callID === id) : -1
    if (id && position < 0) throw new ExecutionQueryError("Context cursor request was not found")
    const items = entries.slice(position + 1, position + 1 + input.limit)
    return ExecutionSchema.ContextHistory.parse({
      sessionID,
      revision: value.revision,
      total: entries.length,
      items,
      nextCursor: position + 1 + items.length < entries.length ? contextCursor(identity, items.at(-1)!.callID) : null,
    })
  }
  export async function contextSnapshot(sessionID: string, callID: string, runID?: string, signal?: AbortSignal) {
    const value = await contextData(sessionID, signal)
    const entry = contextSnapshots(value, runID).find((entry) => entry.callID === callID)
    if (!entry) throw new Storage.NotFoundError({ message: "Context request was not found in this session" })
    return ExecutionSchema.ContextSnapshot.parse(entry)
  }
  export async function contextItems(
    sessionID: string,
    callID: string,
    input: z.infer<typeof ExecutionSchema.ContextItemsQuery>,
    signal?: AbortSignal,
  ) {
    const snapshot = await contextSnapshot(sessionID, callID, input.runID, signal)
    const empty = {
      callID,
      nodeID: snapshot.nodeID,
      contentVersion: null,
      status: "unavailable",
      items: [],
      total: 0,
      nextCursor: null,
      truncated: false,
    }
    if (!snapshot.requestAvailable) return ExecutionSchema.ContextItems.parse(empty)
    const source = await contentSource(sessionID, snapshot.nodeID, "request", input.runID, input.version, signal)
    const manifest = z
      .array(MessageV2.ContextSource)
      .safeParse(await ExecutionContent.value(source, ["contextSources"], signal))
    if (!manifest.success)
      return ExecutionSchema.ContextItems.parse({ ...empty, contentVersion: source.contentVersion, status: "legacy" })
    const sections = new Map<string, z.infer<typeof ExecutionContent.Section>>()
    let next: string | undefined
    let truncated = false
    do {
      const page = await ExecutionContent.sections(source, { field: "request", limit: 500, cursor: next }, signal)
      for (const section of page.items) sections.set(JSON.stringify(section.path), section)
      next = page.nextCursor ?? undefined
      truncated ||= page.truncated
    } while (next)
    const entries = manifest.data.flatMap((entry, index) => {
      const section = sections.get(JSON.stringify(entry.path))
      if (!section) {
        truncated = true
        return []
      }
      if (input.category && input.category !== entry.category) return []
      if (input.query && !entry.source.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) return []
      return [{ ...entry, id: String(index), offset: section.offset, bytes: section.bytes }]
    })
    const identity = JSON.stringify([
      ScopeContext.current.scope.id,
      sessionID,
      callID,
      source.contentVersion,
      input.category,
      input.query,
      input.runID,
    ])
    const id = contextPosition(input.cursor, identity)
    const offset = id ? entries.findIndex((entry) => entry.id === id) + 1 : 0
    if (id && !offset) throw new ExecutionQueryError("Context item cursor was not found")
    const items = entries.slice(offset, offset + input.limit)
    return ExecutionSchema.ContextItems.parse({
      callID,
      nodeID: snapshot.nodeID,
      contentVersion: source.contentVersion,
      status: "available",
      items,
      total: entries.length,
      nextCursor: offset + items.length < entries.length ? contextCursor(identity, items.at(-1)!.id) : null,
      truncated,
    })
  }
  export async function summary(sessionID: string, runID?: string, signal?: AbortSignal) {
    const value = await data(sessionID, true, signal)
    if (!runID) return summarize(value)
    if (!value.summary.rounds.some((round) => round.id === runID))
      throw new Storage.NotFoundError({ message: "Execution round was not found" })
    const summary = summarize(value, runID)
    value.selections.delete(runID)
    value.selections.set(runID, { summary, touched: Date.now() })
    if (value.selections.size > 4) value.selections.delete(value.selections.keys().next().value!)
    return summary
  }
  export async function trajectory(sessionID: string, input: ExecutionSchema.Query, signal?: AbortSignal) {
    const value = await data(sessionID, true, signal)
    if (input.runID && !value.summary.rounds.some((round) => round.id === input.runID))
      throw new Storage.NotFoundError({ message: "Execution round was not found" })
    if (input.session && !value.sessions.some((session) => session.id === input.session))
      throw new Storage.NotFoundError({ message: "Executor does not belong to this task" })
    const query = input.query?.trim().toLocaleLowerCase()
    const kinds = input.kinds
      ?.split(",")
      .filter(Boolean)
      .map((kind) => queryValue(ExecutionSchema.Node.shape.kind, kind))
    const statuses = input.statuses
      ?.split(",")
      .filter(Boolean)
      .map((status) => queryValue(ExecutionSchema.Node.shape.status, status))
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
              (node.kind === "subtask" && value.sessionsByID.get(node.sessionID)?.parentID === sessionID)) &&
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
      const parsed = queryCursor(
        z.object({ filter: z.string(), after: z.string().nullable(), before: z.string().nullable() }),
        input.cursor,
      )
      if (parsed.filter !== fingerprint) throw new ExecutionQueryError("Trajectory cursor does not match its filters")
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
  async function find(sessionID: string, id: string, runID?: string, signal?: AbortSignal) {
    const value = await data(sessionID, true, signal)
    if (runID && !value.summary.rounds.some((round) => round.id === runID))
      throw new Storage.NotFoundError({ message: "Execution round was not found" })
    const node = selected(value, runID).find((node) => node.id === id)
    if (!node) throw new Storage.NotFoundError({ message: "Trajectory node was not found in this session" })
    return { value, node, evidence: value.evidence.get(id), message: value.messages.get(id) }
  }
  export async function node(sessionID: string, id: string, runID?: string, signal?: AbortSignal) {
    const found = await find(sessionID, id, runID, signal)
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
              undefined,
              signal,
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
      execution: ["turn", "subtask"].includes(found.node.kind)
        ? await summary(found.node.sessionID, found.node.kind === "subtask" ? undefined : found.node.runID, signal)
        : undefined,
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
    signal?: AbortSignal,
  ) {
    const source = await contentSource(sessionID, id, field, runID, version, signal)
    checkpoint(signal)
    return source.read(offset, limit)
  }
  export async function contentSource(
    sessionID: string,
    id: string,
    field: string,
    runID?: string,
    version?: string,
    signal?: AbortSignal,
  ): Promise<ExecutionContent.Source> {
    const found = await find(sessionID, id, runID, signal)
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
    const part = message?.parts.find((value) => value.id === found.message!.partID)
    const body = part && "text" in part && typeof part.text === "string" ? part.text : null
    const text = body ?? JSON.stringify(message && { info: message.info, part }, null, 2)
    if (text === undefined) throw new Storage.NotFoundError({ message: "Message content was not found" })
    const mediaType = body === null ? "application/json" : "text/plain"
    const bytes = Buffer.from(text)
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const contentVersion = "message:" + id + ":" + sha256
    if (version && version !== contentVersion) throw new ExecutionQueryError("Execution message version changed")
    return {
      mediaType,
      bytes: bytes.length,
      status: "complete",
      sha256,
      contentVersion,
      read: async (offset, limit) => {
        queryValue(z.number().int().nonnegative().safe(), offset)
        queryValue(z.number().int().min(1).max(65_536), limit)
        if (offset > bytes.length) throw new ExecutionQueryError("Content offset exceeds the recorded message")
        const end = offset + RolloutEvidence.textBoundary(bytes.subarray(offset, offset + limit + 4), limit)
        return ExecutionSchema.Content.parse({
          mediaType,
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
