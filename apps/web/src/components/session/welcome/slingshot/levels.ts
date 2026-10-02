export type Material = "wood" | "stone" | "target" | "bird"
export type Shape = { kind: Material; x: number; y: number; width: number; height: number; radius?: number }
const wood = (x: number, y: number, width: number, height: number): Shape => ({ kind: "wood", x, y, width, height })
const stone = (x: number, y: number, width: number, height: number): Shape => ({ kind: "stone", x, y, width, height })
const target = (x: number, floor = 320): Shape => ({
  kind: "target",
  x,
  y: floor - 12,
  width: 24,
  height: 24,
  radius: 12,
})
const gate = (x: number, floor = 320): Shape[] => [
  wood(x - 32, floor - 28, 12, 56),
  wood(x + 32, floor - 28, 12, 56),
  wood(x, floor - 62, 88, 12),
  target(x, floor),
]
export const slingshotLevels: readonly (readonly Shape[])[] = [
  gate(500),
  [...gate(480), target(610)],
  [stone(530, 310, 150, 20), ...gate(530, 300), target(635)],
  [...gate(450), ...gate(600)],
  [...gate(525), ...gate(525, 252), target(630)],
  [...gate(430), stone(548, 286, 16, 68), wood(582, 246, 88, 12), wood(620, 286, 12, 68), target(580), target(668)],
]
