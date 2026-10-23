import { hexToRgb, type HexColor } from "@ericsanchezok/synergy-plugin/theme"

type Point = readonly [number, number]
export type RibbonPalette = Record<"start" | "middle" | "end", HexColor>
export const ribbonStrips = [
  {
    points: "2,12 5,10 28,9 40,1 43,1 47,9 31,19 9,22 2,20",
    gradient: [2, 17, 46, 4],
    colors: ["end", "middle", "start"],
  },
  { points: "9,22 31,19 41,24 36,28 16,25", gradient: [9, 24, 41, 22], colors: ["middle", "start"] },
  { points: "16,25 36,28 3,47 2,46 2,35", gradient: [3, 44, 36, 27], colors: ["end", "middle"] },
] as const
const stripPoints = ribbonStrips.map((strip) =>
  strip.points.split(" ").map((point) => point.split(",").map(Number) as [number, number]),
)
const spine: Point[] = [
  [45, 5],
  [5, 15.5],
  [37, 25],
  [3, 45],
]
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount
const smooth = (from: number, to: number, value: number) => {
  const amount = Math.max(0, Math.min(1, (value - from) / (to - from)))
  return amount * amount * (3 - 2 * amount)
}

export function completionRibbonGeometry(line: DOMRect, seal: DOMRect, width: number) {
  if (seal.top < line.bottom + 4) return
  const source: Point = [line.right + 4, line.top + line.height / 2]
  const floor = line.bottom + 4
  const exit: Point = [source[0], floor]
  const signature: Point = [seal.left + seal.width / 2, seal.top + seal.height / 2]
  const foldY = Math.max(floor + 8, signature[1] - 6)
  const foldSize = Math.min(24, (foldY - floor) * 2)
  const fold: Point = [seal.left + foldSize / 2, foldY]
  const folded = spine.map(([horizontal, vertical]): Point => [
    fold[0] + ((horizontal - 24) * foldSize) / 48,
    fold[1] + ((vertical - 24) * foldSize) / 48,
  ])
  const direction: Point = [folded[0][0] - folded[1][0], folded[0][1] - folded[1][1]]
  const distance = Math.hypot(...direction)
  const reach = Math.max(
    0,
    Math.min(
      190,
      ((width - folded[0][0] - 10) * distance) / direction[0],
      ((folded[0][1] - floor) * distance) / -direction[1],
    ),
  )
  const control: Point = [exit[0], fold[1]]
  const entry: Point = [
    folded[0][0] + (direction[0] / distance) * reach,
    folded[0][1] + (direction[1] / distance) * reach,
  ]
  const points: Point[] = [source]
  for (let index = 0; index <= 160; index++) {
    const amount = index / 160
    const inverse = 1 - amount
    points.push(
      [0, 1].map(
        (axis) =>
          inverse ** 3 * exit[axis] +
          3 * inverse ** 2 * amount * control[axis] +
          3 * inverse * amount ** 2 * entry[axis] +
          amount ** 3 * folded[0][axis],
      ) as [number, number],
    )
  }
  let spineLength = 0
  for (let index = 0; index < folded.length - 1; index++) {
    const start = folded[index],
      end = folded[index + 1]
    const length = Math.hypot(end[0] - start[0], end[1] - start[1])
    spineLength += length
    const steps = Math.ceil(length / 0.8)
    for (let step = 1; step <= steps; step++)
      points.push([mix(start[0], end[0], step / steps), mix(start[1], end[1], step / steps)])
  }
  const cumulative = [0]
  for (let index = 1; index < points.length; index++)
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]),
    )
  return { points, cumulative, total: cumulative.at(-1)!, spineLength, fold, foldSize, signature }
}

type Geometry = NonNullable<ReturnType<typeof completionRibbonGeometry>>
function at(geometry: Geometry, distance: number): Point {
  const { points, cumulative } = geometry
  distance = Math.max(0, Math.min(geometry.total, distance))
  let low = 0,
    high = cumulative.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (cumulative[middle] < distance) low = middle
    else high = middle
  }
  const amount = (distance - cumulative[low]) / (cumulative[high] - cumulative[low] || 1)
  return [mix(points[low][0], points[high][0], amount), mix(points[low][1], points[high][1], amount)]
}

function logo(context: CanvasRenderingContext2D, center: Point, size: number, palette: RibbonPalette, alpha = 1) {
  context.save()
  context.globalAlpha = alpha
  context.translate(center[0] - size / 2, center[1] - size / 2)
  context.scale(size / 48, size / 48)
  ribbonStrips.forEach((strip, index) => {
    const gradient = context.createLinearGradient(
      strip.gradient[0],
      strip.gradient[1],
      strip.gradient[2],
      strip.gradient[3],
    )
    strip.colors.forEach((color, stop) => gradient.addColorStop(stop / (strip.colors.length - 1), palette[color]))
    context.beginPath()
    stripPoints[index].forEach(([horizontal, vertical], point) =>
      point ? context.lineTo(horizontal, vertical) : context.moveTo(horizontal, vertical),
    )
    context.closePath()
    context.fillStyle = gradient
    context.fill()
  })
  context.restore()
}

function ribbon(
  context: CanvasRenderingContext2D,
  geometry: Geometry,
  start: number,
  end: number,
  folded: number,
  time: number,
  palette: RibbonPalette,
  alpha = 1,
) {
  const length = end - start
  if (length < 1) return
  const steps = Math.max(2, Math.ceil(length / 1.2))
  const colors = [palette.start, palette.middle, palette.end].map(hexToRgb)
  let previous: { left: Point; right: Point } | undefined
  for (let index = 0; index <= steps; index++) {
    const amount = index / steps
    const distance = start + length * amount
    const point = at(geometry, distance),
      before = at(geometry, distance - 1.6),
      after = at(geometry, distance + 1.6)
    const tangent = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1
    const horizontal = (after[0] - before[0]) / tangent,
      vertical = (after[1] - before[1]) / tangent
    const twist = Math.cos((1 - folded) * (amount * 2.3 * Math.PI - time * 0.0055))
    const width = mix(
      7.5 *
        (0.18 + 0.82 * smooth(0, 0.45, amount)) *
        (1 - 0.35 * smooth(0.94, 1, amount)) *
        Math.max(0.14, Math.abs(twist)),
      (geometry.foldSize * 8.6) / 48,
      folded,
    )
    const current = {
      left: [point[0] - (vertical * width) / 2, point[1] + (horizontal * width) / 2] as Point,
      right: [point[0] + (vertical * width) / 2, point[1] - (horizontal * width) / 2] as Point,
    }
    if (previous) {
      const first = amount < 0.5 ? colors[0] : colors[1],
        last = amount < 0.5 ? colors[1] : colors[2]
      const color = (channel: "r" | "g" | "b") =>
        255 * mix(first[channel], last[channel], amount < 0.5 ? amount * 2 : (amount - 0.5) * 2)
      context.fillStyle = `rgba(${color("r")},${color("g")},${color("b")},${alpha * mix(smooth(0, 0.16, amount), 1, folded)})`
      context.beginPath()
      context.moveTo(...previous.left)
      context.lineTo(...current.left)
      context.lineTo(...current.right)
      context.lineTo(...previous.right)
      context.closePath()
      context.fill()
      context.strokeStyle = context.fillStyle
      context.lineWidth = 0.35
      context.stroke()
    }
    previous = current
  }
}

export function drawCompletionRibbon(
  context: CanvasRenderingContext2D,
  geometry: Geometry,
  elapsed: number,
  palette: RibbonPalette,
) {
  if (elapsed < 1550) {
    const progress = elapsed / 1550
    const head = smooth(0, 1, progress) * geometry.total
    const folded = smooth(0.66, 1, progress)
    ribbon(
      context,
      geometry,
      Math.max(0, head - mix(170, geometry.spineLength, folded)),
      head,
      folded,
      elapsed,
      palette,
    )
  } else if (elapsed < 1810) {
    const progress = smooth(0, 1, (elapsed - 1550) / 260)
    logo(context, geometry.fold, geometry.foldSize, palette, progress)
    ribbon(context, geometry, geometry.total - geometry.spineLength, geometry.total, 1, elapsed, palette, 1 - progress)
  } else if (elapsed < 2230) {
    logo(context, geometry.fold, geometry.foldSize, palette)
  } else if (elapsed < 2770) {
    const progress = (elapsed - 2230) / 540
    const shrink = smooth(0, 0.55, progress)
    const dock = smooth(0.55, 1, progress)
    logo(
      context,
      [mix(geometry.fold[0], geometry.signature[0], shrink), mix(geometry.fold[1], geometry.signature[1], dock)],
      mix(geometry.foldSize, 16, shrink),
      palette,
    )
  } else return true
  return false
}
