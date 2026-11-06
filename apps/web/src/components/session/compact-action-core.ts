import { createSignal } from "solid-js"

export type CompactionModel = {
  id: string
  provider: { id: string }
}

export type CompactionNotice = {
  type: "warning" | "error"
  title: string
  description: string
}

export type CompactionNotices = {
  noModel: Omit<CompactionNotice, "type">
  failure: Omit<CompactionNotice, "type">
}

const [pendingSessionIDs, setPendingSessionIDs] = createSignal<ReadonlySet<string>>(new Set())

function setPending(sessionID: string, pending: boolean) {
  setPendingSessionIDs((current) => {
    const next = new Set(current)
    if (pending) next.add(sessionID)
    else next.delete(sessionID)
    return next
  })
}

export function isSessionCompactionPending(sessionID: string | undefined) {
  return sessionID ? pendingSessionIDs().has(sessionID) : false
}

export async function runSessionCompaction(input: {
  sessionID: string | undefined
  model: CompactionModel | undefined
  summarize: (request: { sessionID: string; modelID: string; providerID: string }) => Promise<unknown>
  notify: (notice: CompactionNotice) => unknown
  notices: CompactionNotices
}) {
  const sessionID = input.sessionID
  if (!sessionID || isSessionCompactionPending(sessionID)) return false
  if (!input.model) {
    input.notify({ type: "warning", ...input.notices.noModel })
    return false
  }

  setPending(sessionID, true)
  try {
    await input.summarize({
      sessionID,
      modelID: input.model.id,
      providerID: input.model.provider.id,
    })
    return true
  } catch (error) {
    input.notify({
      type: "error",
      title: input.notices.failure.title,
      description: error instanceof Error ? error.message : input.notices.failure.description,
    })
    return false
  } finally {
    setPending(sessionID, false)
  }
}
