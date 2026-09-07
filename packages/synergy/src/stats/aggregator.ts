import { RolloutSnapshot } from "@/session/rollout/snapshot"
import { RolloutAccounting } from "@/session/rollout/accounting"
import { MessageV2 } from "@/session/message-v2"
import type { Info as SessionInfo } from "@/session/types"
import type * as Stats from "@/stats/types"

export namespace Aggregator {
  const emptyTokenBreakdown = (): Stats.TokenBreakdown => ({
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  function addTokens(target: Stats.TokenBreakdown, source: Stats.TokenBreakdown) {
    target.input += source.input
    target.output += source.output
    target.reasoning += source.reasoning
    target.cache.read += source.cache.read
    target.cache.write += source.cache.write
  }

  export type DigestProgress = (current: number, total: number) => void

  export async function digest(session: SessionInfo): Promise<Stats.SessionDigest> {
    // Pass scopeID directly to avoid requireSession looking up session_index,
    // which may be missing for legacy or reclaimed sessions.
    const scopeID = (session.scope as { id: string })?.id
    const messages: MessageV2.WithParts[] = []
    for await (const msg of MessageV2.stream({
      scopeID,
      sessionID: session.id,
    })) {
      messages.push(msg)
    }

    const rollout = await RolloutSnapshot.read({ kind: "session", scopeID: session.scope.id, sessionID: session.id })
    const recordedRoots = new Set(rollout.runs.map((run) => run.id))
    const accounting = RolloutAccounting.summarize(rollout)
    const tokens = emptyTokenBreakdown()
    let cost = 0
    let turns = 0
    let messageCount = 0
    let errorCount = 0
    let compactionCount = 0
    let retryCount = 0

    const modelUsage: Stats.SessionDigest["modelUsage"] = {}
    const agentUsage: Stats.SessionDigest["agentUsage"] = {}
    const toolUsage: Stats.SessionDigest["toolUsage"] = {}
    const hourlyTurns: Stats.SessionDigest["hourlyTurns"] = {}

    function hourKey(timestamp: number) {
      const d = new Date(timestamp)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}`
    }

    for (const msg of messages) {
      messageCount++

      if (msg.info.role === "user") {
        turns++
        const key = hourKey(msg.info.time.created)
        hourlyTurns[key] = (hourlyTurns[key] ?? 0) + 1
      }

      if (msg.info.role === "assistant") {
        const info = msg.info
        const legacy =
          info.accounting?.kind !== "inherited" &&
          info.accounting?.kind !== "imported" &&
          info.accounting?.kind !== "rollout" &&
          !recordedRoots.has(info.rootID ?? info.parentID)
        const messageTokens = legacy ? info.tokens : emptyTokenBreakdown()
        const messageCost = legacy ? info.cost : 0
        if (legacy) {
          accounting.legacy.cost += info.cost
          accounting.legacy.messages++
        }
        addTokens(tokens, messageTokens)
        cost += messageCost

        if (info.error !== undefined) errorCount++

        const modelKey = `${info.providerID}/${info.modelID}`
        const modelEntry = modelUsage[modelKey] ?? {
          messages: 0,
          tokens: emptyTokenBreakdown(),
          cost: 0,
          totalResponseMs: 0,
        }
        modelEntry.messages++
        addTokens(modelEntry.tokens, messageTokens)
        modelEntry.cost += messageCost
        if (legacy) {
          modelEntry.accounting ??= RolloutAccounting.empty()
          modelEntry.accounting.legacy.cost += messageCost
          modelEntry.accounting.legacy.messages++
        }
        if (legacy && info.time.completed !== undefined) {
          modelEntry.totalResponseMs += info.time.completed - info.time.created
        }
        modelUsage[modelKey] = modelEntry

        const agentEntry = agentUsage[info.agent] ?? {
          messages: 0,
          tokens: emptyTokenBreakdown(),
          cost: 0,
        }
        agentEntry.messages++
        addTokens(agentEntry.tokens, messageTokens)
        agentEntry.cost += messageCost
        if (legacy) {
          agentEntry.accounting ??= RolloutAccounting.empty()
          agentEntry.accounting.legacy.cost += messageCost
          agentEntry.accounting.legacy.messages++
        }
        agentUsage[info.agent] = agentEntry
      }

      for (const part of msg.parts) {
        if (part.type === "tool") {
          const toolEntry = toolUsage[part.tool] ?? {
            calls: 0,
            successes: 0,
            errors: 0,
            totalDurationMs: 0,
          }
          toolEntry.calls++
          if (part.state.status === "completed") {
            toolEntry.successes++
            if (part.state.time.start !== undefined && part.state.time.end !== undefined) {
              toolEntry.totalDurationMs += part.state.time.end - part.state.time.start
            }
          }
          if (part.state.status === "error") {
            toolEntry.errors++
          }
          toolUsage[part.tool] = toolEntry
        }
        if (part.type === "compaction") compactionCount++
        if (part.type === "retry") retryCount++
      }
    }

    const totals = { tokens, cost, modelUsage, agentUsage }
    addCalls(rollout, totals)
    cost = totals.cost

    const endpoint = session.endpoint
      ? {
          kind: session.endpoint.kind,
          type: session.endpoint.kind === "channel" ? session.endpoint.channel.type : undefined,
        }
      : undefined

    const interaction = session.interaction
      ? {
          mode: session.interaction.mode,
          source: session.interaction.source,
        }
      : undefined

    return {
      sessionID: session.id,
      scopeID: session.scope.id,
      created: session.time.created,
      updated: session.time.updated,
      rolloutRevision: rollout.revision,
      accounting,
      archived: session.time.archived,
      pinned: session.pinned !== undefined,
      parentID: session.parentID,
      endpoint,
      interaction,
      turns,
      messages: messageCount,
      tokens,
      cost,
      modelUsage,
      agentUsage,
      toolUsage,
      hourlyTurns,
      additions: session.summary?.additions ?? 0,
      deletions: session.summary?.deletions ?? 0,
      files: session.summary?.files ?? 0,
      compactionCount,
      retryCount,
      errorCount,
      durationMs: session.time.updated - session.time.created,
    }
  }

  function addCalls(
    rollout: RolloutSnapshot.Info,
    totals: Pick<Stats.SessionDigest, "tokens" | "cost" | "modelUsage" | "agentUsage">,
  ) {
    const attemptsByCall = Map.groupBy(rollout.attempts, (attempt) => attempt.callID)
    for (const call of rollout.calls) {
      const entry = RolloutAccounting.summarize({
        calls: [call],
        attempts: attemptsByCall.get(call.id) ?? [],
        gaps: [],
      })
      const usage = {
        input: entry.tokens.uncached.known,
        output: entry.tokens.output.known,
        reasoning: entry.tokens.reasoning.known,
        cache: { read: entry.tokens.cacheRead.known, write: entry.tokens.cacheWrite.known },
      }
      const knownCost = entry.apiEstimate.known
      addTokens(totals.tokens, usage)
      totals.cost += knownCost
      const modelKey = `${call.model.providerID}/${call.model.modelID}`
      const modelEntry = totals.modelUsage[modelKey] ?? {
        messages: 0,
        tokens: emptyTokenBreakdown(),
        cost: 0,
        totalResponseMs: 0,
      }
      addTokens(modelEntry.tokens, usage)
      modelEntry.cost += knownCost
      if (call.ended !== undefined) modelEntry.totalResponseMs += call.ended - call.started
      modelEntry.accounting = RolloutAccounting.merge([modelEntry.accounting ?? RolloutAccounting.empty(), entry])
      totals.modelUsage[modelKey] = modelEntry
      const agentKey = call.agent ?? call.purpose
      const agentEntry = totals.agentUsage[agentKey] ?? { messages: 0, tokens: emptyTokenBreakdown(), cost: 0 }
      addTokens(agentEntry.tokens, usage)
      agentEntry.cost += knownCost
      agentEntry.accounting = RolloutAccounting.merge([agentEntry.accounting ?? RolloutAccounting.empty(), entry])
      totals.agentUsage[agentKey] = agentEntry
    }
  }

  export function operation(rollout: RolloutSnapshot.Info): Stats.OperationDigest {
    if (rollout.owner.kind !== "operation") throw new Error("Expected independent operation")
    const started = rollout.runs.map((run) => run.started)
    const result: Stats.OperationDigest = {
      operationID: rollout.owner.operationID,
      scopeID: rollout.owner.scopeID,
      rolloutRevision: rollout.revision,
      created: started.length ? Math.min(...started) : 0,
      updated: Math.max(0, ...rollout.runs.map((run) => run.ended ?? run.started)),
      turns: 0,
      tokens: emptyTokenBreakdown(),
      cost: 0,
      modelUsage: {},
      agentUsage: {},
      accounting: RolloutAccounting.summarize(rollout),
    }
    addCalls(rollout, result)
    return result
  }

  export async function digestAll(
    sessions: SessionInfo[],
    onProgress?: DigestProgress,
  ): Promise<Stats.SessionDigest[]> {
    const results: Stats.SessionDigest[] = []
    const batchSize = 20

    for (let i = 0; i < sessions.length; i += batchSize) {
      const batch = sessions.slice(i, i + batchSize)
      const batchResults = await Promise.all(batch.map((s) => digest(s)))
      for (const r of batchResults) {
        if (r) results.push(r)
      }
      onProgress?.(Math.min(i + batchSize, sessions.length), sessions.length)
    }

    return results
  }
}
