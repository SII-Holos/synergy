export const RESIZE_KEYBOARD_STEP = 8

export interface SeparatorKeyboardState {
  size: number
  min: number
  max: number
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
}

export function clampSeparatorSize(size: number, state: { min: number; max: number }) {
  return Math.max(state.min, Math.min(state.max, Math.round(size)))
}

export function resolveSeparatorKeyboardSize(key: string, state: SeparatorKeyboardState): number | undefined {
  if (key === "Home") return state.min
  if (key === "End") return state.max
  // Keyboard growth must match the pointer gesture: a start-edge handle grows
  // toward the negative axis, an end-edge handle toward the positive axis.
  const forward = (state.edge ?? "end") === "start" ? -1 : 1
  let step = 0
  if (state.direction === "horizontal") {
    if (key === "ArrowRight") step = 1
    else if (key === "ArrowLeft") step = -1
  } else {
    if (key === "ArrowDown") step = 1
    else if (key === "ArrowUp") step = -1
  }
  if (step === 0) return undefined
  return clampSeparatorSize(state.size + step * RESIZE_KEYBOARD_STEP * forward, state)
}
