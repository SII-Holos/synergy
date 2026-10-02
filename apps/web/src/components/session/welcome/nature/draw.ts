import type { Nature } from "./model"

export type NatureColors = { ground: string; edge: string; water: string; leaf: string; seed: string; light: string }

export function drawNature(
  canvas: HTMLCanvasElement,
  state: Nature,
  colors: NatureColors,
  cursor?: { x: number; y: number },
) {
  const context = canvas.getContext("2d")
  if (!context) return
  const size = canvas.getBoundingClientRect()
  const ratio = Math.min(devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.round(size.width * ratio)),
    height = Math.max(1, Math.round(size.height * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  context.setTransform(width / state.width, 0, 0, height / state.height, 0, 0)
  context.clearRect(0, 0, state.width, state.height)
  for (const material of [1, 2]) {
    context.globalAlpha = material === 1 ? 0.18 : 0.65
    context.fillStyle = material === 1 ? colors.ground : colors.water
    for (let y = 0; y < state.height; y++) {
      let start = -1
      for (let x = 0; x <= state.width; x++) {
        const filled = x < state.width && state.cells[y * state.width + x] === material
        if (filled && start < 0) start = x
        if (!filled && start >= 0) {
          context.fillRect(start, y, x - start, 1.05)
          start = -1
        }
      }
    }
  }
  context.globalAlpha = 1
  context.strokeStyle = colors.edge
  context.lineWidth = 0.3
  context.beginPath()
  for (let x = 0; x < state.width; x++) {
    for (let y = 0; y < state.height; y++) {
      if (state.cells[y * state.width + x] !== 1) continue
      context.moveTo(x, y)
      context.lineTo(x + 1, y)
      break
    }
  }
  context.stroke()
  context.globalAlpha = 0.22
  for (let x = 2; x < state.width; x += 5) {
    for (let y = 58 + (x % 9); y < state.height; y += 8) {
      if (state.cells[y * state.width + x] !== 1) continue
      context.beginPath()
      context.moveTo(x, y)
      context.lineTo(x + 1.5, y - 0.3)
      context.stroke()
    }
  }
  context.globalAlpha = 1
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i] !== 3) continue
    const x = (i % state.width) + 0.5,
      y = Math.floor(i / state.width) + 0.5
    const growth = state.growth[i]!
    context.fillStyle = colors.seed
    context.beginPath()
    context.ellipse(x, y, 0.7, 0.45, -0.3, 0, Math.PI * 2)
    context.fill()
    if (!growth) continue
    const height = growth * 1.15
    const bend = Math.sin(state.tick / 22 + x) * (0.3 + Math.abs(state.wind) * 1.2)
    context.lineWidth = 0.6
    context.strokeStyle = colors.leaf
    context.beginPath()
    context.moveTo(x, y)
    context.quadraticCurveTo(x - bend, y - height / 2, x + bend, y - height)
    context.stroke()
    context.fillStyle = colors.leaf
    for (let leaf = 1; leaf < growth; leaf += 3) {
      const direction = leaf % 2 ? -1 : 1
      context.beginPath()
      context.ellipse(x + direction * 1.8, y - leaf * 1.1, 2.6, 0.9, direction * 0.6, 0, Math.PI * 2)
      context.fill()
    }
    if (growth >= 10) {
      context.fillStyle = colors.light
      for (let petal = 0; petal < 5; petal++) {
        const angle = (petal * Math.PI * 2) / 5
        context.beginPath()
        context.ellipse(
          x + bend + Math.cos(angle) * 1.4,
          y - height + Math.sin(angle) * 1.4,
          1.4,
          0.9,
          angle,
          0,
          Math.PI * 2,
        )
        context.fill()
      }
      context.fillStyle = colors.leaf
      context.beginPath()
      context.arc(x + bend, y - height, 0.75, 0, Math.PI * 2)
      context.fill()
    }
  }
  if (cursor) {
    context.strokeStyle = colors.edge
    context.lineWidth = 0.45
    context.setLineDash([1, 1])
    context.beginPath()
    context.arc(cursor.x, cursor.y, 3, 0, Math.PI * 2)
    context.stroke()
    context.setLineDash([])
  }
}
