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

    let currentTurnUser: string | null = null

    function hourKey(timestamp: number) {
      const d = new Date(timestamp)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}`
    }

    for (const msg of messages) {
      messageCount++

      if (msg.info.role === "user") {
        turns++
        currentTurnUser = msg.info.id
        const key = hourKey(msg.info.time.created)
        hourlyTurns[key] = (hourlyTurns[key] ?? 0) + 1
      }

      if (msg.info.role === "assistant") {
        const info = msg.info
        addTokens(tokens, info.tokens)
        cost += info.cost

        if (info.error !== undefined) errorCount++

        const modelKey = `${info.providerID}/${info.modelID}`
        const modelEntry = modelUsage[modelKey] ?? {
          messages: 0,
          tokens: emptyTokenBreakdown(),
          cost: 0,
          totalResponseMs: 0,
        }
        modelEntry.messages++
        addTokens(modelEntry.tokens, info.tokens)
        modelEntry.cost += info.cost
        if (info.time.completed !== undefined) {
          modelEntry.totalResponseMs += info.time.completed - info.time.created
        }
        modelUsage[modelKey] = modelEntry

        const agentEntry = agentUsage[info.agent] ?? {
          messages: 0,
          tokens: emptyTokenBreakdown(),
          cost: 0,
        }
        agentEntry.messages++
        addTokens(agentEntry.tokens, info.tokens)
        agentEntry.cost += info.cost
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

  export async function digestAll(
    sessions: SessionInfo[],
    onProgress?: DigestProgress,
  ): Promise<Stats.SessionDigest[]> {
    const results: Stats.SessionDigest[] = []
    const batchSize = 20

    for (let i = 0; i < sessions.length; i += batchSize) {
      const batch = sessions.slice(i, i + batchSize)
      const batchResults = await Promise.all(batch.map((s) => digest(s).catch(() => undefined)))
      for (const r of batchResults) {
        if (r) results.push(r)
      }
      onProgress?.(Math.min(i + batchSize, sessions.length), sessions.length)
    }

    return results
  }
}
