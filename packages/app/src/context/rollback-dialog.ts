export type RollbackDialogPresentationState = {
  seenKey?: string
}

export type RollbackDialogPresentationEvent = { type: "presented"; key: string } | { type: "session_removed" }

export const emptyRollbackDialogPresentationState: RollbackDialogPresentationState = {}

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
