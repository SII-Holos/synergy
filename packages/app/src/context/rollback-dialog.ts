export type RollbackDialogPresentationState = {
  seenKey?: string
}

export type RollbackDialogPresentationEvent = { type: "presented"; key: string } | { type: "session_removed" }

export const emptyRollbackDialogPresentationState: RollbackDialogPresentationState = {}

type RollbackDialogStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

const ROLLBACK_DIALOG_STORAGE_PREFIX = "synergy.rollback-dialog.seen.v1:"

function persistedRollbackDialogKey(sessionID: string) {
  return `${ROLLBACK_DIALOG_STORAGE_PREFIX}${sessionID}`
}

export function browserRollbackDialogStorage(): RollbackDialogStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readPersistedRollbackDialogSeenKey(
  storage: RollbackDialogStorage | undefined,
  sessionID: string,
): string | undefined {
  if (!storage) return undefined
  try {
    return storage.getItem(persistedRollbackDialogKey(sessionID)) ?? undefined
  } catch {
    return undefined
  }
}

export function writePersistedRollbackDialogSeenKey(
  storage: RollbackDialogStorage | undefined,
  sessionID: string,
  seenKey: string,
) {
  if (!storage) return
  try {
    storage.setItem(persistedRollbackDialogKey(sessionID), seenKey)
  } catch {
    return
  }
}

export function removePersistedRollbackDialogSeenKey(storage: RollbackDialogStorage | undefined, sessionID: string) {
  if (!storage) return
  try {
    storage.removeItem(persistedRollbackDialogKey(sessionID))
  } catch {
    return
  }
}

export function isEmptyRollbackDialogPresentationState(state: RollbackDialogPresentationState): boolean {
  return state.seenKey === undefined
}

export function reduceRollbackDialogPresentationState(
  state: RollbackDialogPresentationState,
  event: RollbackDialogPresentationEvent,
): RollbackDialogPresentationState {
  switch (event.type) {
    case "presented":
      if (state.seenKey === event.key) return state
      return { seenKey: event.key }
    case "session_removed":
      return emptyRollbackDialogPresentationState
  }
}
