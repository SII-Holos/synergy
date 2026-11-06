import type { MessageV2 } from "./message-v2"

export type ModelWorkingSetProjection = {
  latestSummaryIndex: number
  boundaryIndex: number
  boundaryUserID: string
  coveredThrough: { created: number; messageID: string }
}

export function modelWorkingSetProjection(infos: MessageV2.Info[]): ModelWorkingSetProjection | undefined {
  let latestSummaryIndex = -1
  for (let index = 0; index < infos.length; index++) {
    const info = infos[index]
    if (info.role !== "assistant" || !info.summary || !info.finish) continue
    if (latestSummaryIndex < 0 || compareChronology(info, infos[latestSummaryIndex]) > 0) latestSummaryIndex = index
  }
  const summary = infos[latestSummaryIndex]
  if (summary?.role !== "assistant" || !summary.compaction) return
  const boundaryUserID = summary.parentID

  const boundaryIndex = infos.findIndex((info) => info.role === "user" && info.id === boundaryUserID)
  if (boundaryIndex < 0) return
  return { latestSummaryIndex, boundaryIndex, boundaryUserID, coveredThrough: summary.compaction.coveredThrough }
}

export function compareChronology(a: MessageV2.Info, b: MessageV2.Info): number {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

export function afterCompaction(info: MessageV2.Info, through: ModelWorkingSetProjection["coveredThrough"]) {
  return (
    info.time.created > through.created ||
    (info.time.created === through.created && info.id.localeCompare(through.messageID) > 0)
  )
}

export function applyModelWorkingSetProjection<T>(
  items: T[],
  projection: ModelWorkingSetProjection,
  infoOf: (item: T) => MessageV2.Info,
  excludeEarlierSummary: (item: T) => T,
): T[] {
  const ordered = items.slice().sort((a, b) => compareChronology(infoOf(a), infoOf(b)))
  const summary = items[projection.latestSummaryIndex]
  const earlierSummaries = ordered.flatMap((item) => {
    const info = infoOf(item)
    if (
      item === summary ||
      info.role !== "assistant" ||
      info.parentID !== projection.boundaryUserID ||
      !info.summary ||
      !info.finish ||
      compareChronology(info, infoOf(summary)) >= 0
    ) {
      return []
    }
    return [excludeEarlierSummary(item)]
  })
  const tail = ordered.filter((item) => {
    const info = infoOf(item)
    return (
      info.id !== projection.boundaryUserID &&
      item !== summary &&
      !(info.role === "assistant" && info.summary && info.finish) &&
      afterCompaction(info, projection.coveredThrough)
    )
  })
  return [items[projection.boundaryIndex], ...earlierSummaries, summary, ...tail]
}

export function selectModelWorkingSet<T>(
  items: T[],
  projection: ModelWorkingSetProjection,
  infoOf: (item: T) => MessageV2.Info,
  excludeEarlierSummary: (item: T) => T,
): T[] {
  return applyModelWorkingSetProjection(items, projection, infoOf, excludeEarlierSummary).sort((a, b) =>
    compareChronology(infoOf(a), infoOf(b)),
  )
}

export function modelWorkingSetForPrompt(messages: MessageV2.WithParts[]) {
  const projection = modelWorkingSetProjection(messages.map((message) => message.info))
  if (!projection || !messages[projection.boundaryIndex].parts.some((part) => part.type === "compaction"))
    return messages
  return applyModelWorkingSetProjection(
    messages,
    projection,
    (message) => message.info,
    (message) => ({ ...message, info: { ...message.info, includeInContext: false } }),
  )
}
