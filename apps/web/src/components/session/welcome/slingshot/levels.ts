import { sceneRandom } from "../random"

export type Material = "wood" | "stone" | "target" | "bird"
export type Shape = { kind: Material; x: number; y: number; width: number; height: number; radius?: number }
const block = (kind: "wood" | "stone", x: number, y: number, width: number, height: number): Shape => ({
  kind,
  x,
  y,
  width,
  height,
})
const target = (x: number, floor: number): Shape => ({
  kind: "target",
  x,
  y: floor - 12,
  width: 24,
  height: 24,
  radius: 12,
})

export function createSlingLevel(seed: number, level: number): Shape[] {
  const random = sceneRandom(Math.imul(seed ^ (seed >>> 16) ^ Math.imul(level + 1, 0x9e3779b9), 0x85ebca6b))
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  const shapes: Shape[] = []
  const cap = (x: number, floor: number) => shapes.push(block("stone", x, floor - 12, 24, 24))
  const bay = (x: number, floor: number, span: number, height: number, stone = false) => {
    shapes.push(
      block("wood", x - span / 2, floor - height / 2, 12, height),
      block(stone ? "stone" : "wood", x + span / 2, floor - height / 2, 12, height),
      block("wood", x, floor - height - 6, span + 28, 12),
      target(x, floor),
    )
    return floor - height - 12
  }
  const tower = (x: number, tiers: number) => {
    let floor = 320
    const span = pick([64, 72, 80])
    const height = pick([48, 56, 64])
    for (let tier = 0; tier < tiers; tier++) {
      const offset = tier ? pick([-4, 0, 4]) : 0
      floor = bay(x + offset, floor, span - tier * 8, height, level > 1 && random() < 0.35)
    }
    cap(x + pick([-16, 0, 16]), floor)
  }
  switch (pick(["tower", "twins", "bridge"])) {
    case "tower":
      tower(pick([480, 496, 512, 528, 544]) + pick([-6, 0, 6]), level >= 4 ? 3 : 2)
      break
    case "twins": {
      const left = pick([416, 432, 448, 464])
      tower(left, level > 1 && random() < 0.6 ? 2 : 1)
      tower(left + pick([136, 152, 168]), level > 3 && random() < 0.6 ? 2 : 1)
      break
    }
    case "bridge": {
      const x = pick([516, 532, 548])
      const span = pick([168, 184, 200])
      const height = pick([64, 72, 80])
      shapes.push(
        block("wood", x - span / 2, 320 - height / 2, 14, height),
        block("wood", x + span / 2, 320 - height / 2, 14, height),
        block("wood", x, 314 - height, span + 28, 12),
        target(x - span / 4, 320),
        target(x + span / 4, 320),
      )
      const center = x + pick([-16, 0, 16])
      const top = bay(center, 308 - height, pick([56, 64, 72]), pick([40, 48]), level > 2)
      cap(center, top)
      break
    }
  }
  return shapes
}
