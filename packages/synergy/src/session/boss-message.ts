interface BossAssignmentTarget {
  id: string
  parentID?: string
}

interface BossMessageEnvelope {
  isRoot?: boolean
  origin?: {
    type?: string
    detail?: string
  }
  metadata?: Record<string, unknown>
}

interface BossAssignmentMetadata extends Record<string, unknown> {
  from: string
  to: string
  taskID: string
}

export function bossAssignmentMetadata(
  message: BossMessageEnvelope | undefined,
  target: BossAssignmentTarget,
  options: { requireRoot?: boolean } = {},
): BossAssignmentMetadata | undefined {
  if (!message || (options.requireRoot && message.isRoot !== true)) return undefined
  if (message.origin?.type !== "system" || message.origin.detail !== "boss_assign") return undefined
  if (!target.parentID) return undefined

  const boss = message.metadata?.boss
  if (!boss || typeof boss !== "object") return undefined
  const metadata = boss as Record<string, unknown>
  if (metadata.from !== target.parentID || metadata.to !== target.id || typeof metadata.taskID !== "string") {
    return undefined
  }
  return metadata as BossAssignmentMetadata
}
