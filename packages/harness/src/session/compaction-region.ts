import type { ModelMessage } from "ai"
import type { MessageV2 } from "./message-v2"
import { compareChronology } from "./model-working-set"

// Provenance: https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/region.ts
// Local adaptation: retain a recent tail and summarize an atomic prefix;
// context-overflow retries shrink that prefix without discarding its remainder.
export namespace CompactionRegion {
  export type Cursor = NonNullable<MessageV2.Assistant["compaction"]>["coveredThrough"]
  export type Group = { messageIDs: string[]; indexes: number[]; coveredThrough: Cursor }
  export type Projection = { groups: Group[]; fixedIndexes: number[] }

  export function project(input: {
    messages: ModelMessage[]
    messageSources: string[]
    infos: MessageV2.Info[]
    rootID: string
  }): Projection {
    if (input.messageSources.length !== input.messages.length)
      throw new Error("Compaction message sources do not match the prepared request")
    const sources = new Set(input.messageSources)
    const infos = input.infos.filter(
      (info) => info.id !== input.rootID && sources.has(info.id) && info.includeInContext !== false,
    )
    infos.sort((a, b) => {
      const aSummary = a.role === "assistant" && a.summary === true
      const bSummary = b.role === "assistant" && b.summary === true
      return Number(bSummary) - Number(aSummary) || compareChronology(a, b)
    })
    const indexByID = new Map(infos.map((info, index) => [info.id, index]))
    const groups = infos.map((info): Group => ({
      messageIDs: [info.id],
      indexes: [],
      coveredThrough:
        info.role === "assistant" && info.compaction
          ? info.compaction.coveredThrough
          : { created: info.time.created, messageID: info.id },
    }))
    const fixedIndexes: number[] = []
    const ends = groups.map((_, index) => index)
    const calls = new Map<string, number>()
    for (const [index, message] of input.messages.entries()) {
      const group = indexByID.get(input.messageSources[index])
      if (group === undefined) {
        fixedIndexes.push(index)
        continue
      }
      groups[group].indexes.push(index)
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type !== "tool-call" && part.type !== "tool-result") continue
        if (part.type === "tool-call") calls.set(part.toolCallId, group)
        else {
          const previous = calls.get(part.toolCallId)
          if (previous !== undefined)
            ends[Math.min(previous, group)] = Math.max(ends[Math.min(previous, group)], previous, group)
          calls.delete(part.toolCallId)
        }
      }
    }
    if (infos[0]?.role === "assistant" && infos[0].summary && groups.length > 1) {
      const next = groups.findIndex((group) => compareCursor(group.coveredThrough, groups[0].coveredThrough) > 0)
      ends[0] = Math.max(ends[0], next < 0 ? groups.length - 1 : next)
    }
    const atomic: Group[] = []
    for (let start = 0; start < groups.length;) {
      let end = ends[start]
      for (let index = start; index <= end; index++) end = Math.max(end, ends[index])
      const selected = groups.slice(start, end + 1)
      const coveredThrough = selected
        .map((group) => group.coveredThrough)
        .sort(compareCursor)
        .at(-1)!
      atomic.push({
        messageIDs: selected.flatMap((group) => group.messageIDs),
        indexes: selected.flatMap((group) => group.indexes),
        coveredThrough,
      })
      start = end + 1
    }
    return { groups: atomic, fixedIndexes }
  }

  export function compareCursor(a: Cursor, b: Cursor) {
    return a.created - b.created || a.messageID.localeCompare(b.messageID)
  }

  export function select(costs: number[], budget: number): number {
    if (!costs.length || budget <= 0) return 0
    let tail = 0
    let end = costs.length
    const retained = Number.isFinite(budget) ? budget * 0.16 : 0
    while (end > 1 && tail < retained) tail += costs[--end]
    let used = 0
    let count = 0
    while (count < end && used + costs[count] <= budget) used += costs[count++]
    return count
  }

  export function shrink(count: number) {
    return count > 1 ? Math.floor(count / 2) : 0
  }

  export function indexes(projection: Projection, count: number) {
    return [...projection.fixedIndexes, ...projection.groups.slice(0, count).flatMap((group) => group.indexes)].sort(
      (a, b) => a - b,
    )
  }
}
