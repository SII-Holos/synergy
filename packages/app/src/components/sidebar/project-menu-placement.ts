export type ProjectMenuPlacement = "up" | "down"

export function projectMenuPlacement(input: {
  triggerBottom: number
  boundaryBottom: number
  menuHeight: number
}): ProjectMenuPlacement {
  return input.boundaryBottom - input.triggerBottom >= input.menuHeight ? "down" : "up"
}
