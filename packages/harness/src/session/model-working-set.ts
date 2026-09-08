import type { MessageV2 } from "./message-v2"

export type ModelWorkingSetProjection = {
  latestSummaryIndex: number
  boundaryIndex: number
  boundaryUserID: string
}

export function modelWorkingSetProjection(infos: MessageV2.Info[]): ModelWorkingSetProjection | undefined {
  let latestSummaryIndex = -1
  let boundaryUserID: string | undefined
  for (let index = infos.length - 1; index >= 0; index--) {
    const info = infos[index]
    if (info.role !== "assistant" || !info.summary || !info.finish) continue
    latestSummaryIndex = index
    boundaryUserID = info.parentID
    break
  }
  if (latestSummaryIndex < 0 || !boundaryUserID) return

  const boundaryIndex = infos.findIndex(
    (info, index) => index < latestSummaryIndex && info.role === "user" && info.id === boundaryUserID,
  )
  if (boundaryIndex < 0) return
  return { latestSummaryIndex, boundaryIndex, boundaryUserID }
}

export function applyModelWorkingSetProjection<T>(
  items: T[],
  projection: ModelWorkingSetProjection,
  infoOf: (item: T) => MessageV2.Info,
  excludeEarlierSummary: (item: T) => T,
): T[] {
  const earlierSummaries = items.slice(projection.boundaryIndex + 1, projection.latestSummaryIndex).flatMap((item) => {
    const info = infoOf(item)
    if (info.role !== "assistant" || info.parentID !== projection.boundaryUserID || !info.summary || !info.finish) {
      return []
    }
    return [excludeEarlierSummary(item)]
  })
  return [items[projection.boundaryIndex], ...earlierSummaries, ...items.slice(projection.latestSummaryIndex)]
}
