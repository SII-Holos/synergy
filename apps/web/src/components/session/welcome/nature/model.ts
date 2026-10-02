export type NatureTool = "soil" | "dig" | "water" | "seed"
export type Nature = {
  width: number
  height: number
  cells: Uint8Array
  growth: Uint8Array
  tick: number
  wind: number
  lowGravity: boolean
}

export function createNature(seed: number, width = 160, height = 90): Nature {
  const cells = new Uint8Array(width * height)
  const surface = (x: number) => Math.floor(height * 0.64 + Math.sin((x / width) * 8 + (seed % 5)) * height * 0.07)
  for (let x = 0; x < width; x++) {
    const top = x > width * 0.47 && x < width * 0.55 ? Math.floor(height * 0.41) : surface(x)
    for (let y = top; y < height; y++) cells[y * width + x] = 1
    if (x > width * 0.12 && x < width * 0.29) {
      for (let y = Math.floor(height * 0.4); y < top; y++) cells[y * width + x] = 2
    }
  }
  for (const portion of [0.69, 0.78, 0.86]) {
    const x = Math.floor(width * portion)
    cells[(surface(x) - 1) * width + x] = 3
  }
  return { width, height, cells, growth: new Uint8Array(cells.length), tick: 0, wind: 0, lowGravity: false }
}

export function paintNature(
  state: Nature,
  tool: NatureTool,
  x: number,
  y: number,
  radius = tool === "seed" ? 0 : 2,
): Nature {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state
  const cells = state.cells.slice()
  const growth = state.growth.slice()
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue
      const column = Math.round(x) + dx,
        row = Math.round(y) + dy
      if (column < 0 || column >= state.width || row < 0 || row >= state.height - 1) continue
      const index = row * state.width + column
      if (tool === "water" && cells[index] !== 0) continue
      if (tool === "seed" && cells[index] !== 0) continue
      cells[index] = tool === "soil" ? 1 : tool === "water" ? 2 : tool === "seed" ? 3 : 0
      growth[index] = 0
    }
  }
  return { ...state, cells, growth }
}

export function stepNature(state: Nature) {
  state.tick++
  if (state.lowGravity && state.tick % 2) return
  const { width, height, cells, growth } = state
  const moved = new Uint8Array(cells.length)
  const direction = state.wind || (state.tick % 2 ? 1 : -1)
  for (let y = height - 1; y >= 0; y--) {
    for (let offset = 0; offset < width; offset++) {
      const x = direction > 0 ? width - 1 - offset : offset
      const index = y * width + x
      const material = cells[index]
      if ((material !== 2 && material !== 3) || moved[index]) continue
      if (material === 3) {
        let watered = growth[index]! > 0
        for (const [dx, dy] of [
          [0, -1],
          [-1, 0],
          [1, 0],
          [-1, -1],
          [1, -1],
        ]) {
          const nx = x + dx!,
            ny = y + dy!
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && cells[ny * width + nx] === 2) watered = true
        }
        if (watered && state.tick % 4 === 0) growth[index] = Math.min(12, growth[index]! + 1)
        if (growth[index]) continue
      }
      const candidates =
        material === 3
          ? [[0, 1]]
          : [
              [0, 1],
              [direction, 1],
              [-direction, 1],
              [direction, 0],
              [-direction, 0],
            ]
      for (const [dx, dy] of candidates) {
        const nx = x + dx!,
          ny = y + dy!
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const next = ny * width + nx
        if (cells[next] !== 0) continue
        cells[next] = material
        cells[index] = 0
        growth[next] = growth[index]!
        growth[index] = 0
        moved[next] = 1
        break
      }
    }
  }
}

export function natureCounts(state: Nature) {
  let water = 0,
    grown = 0
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i] === 2) water++
    if (state.cells[i] === 3 && state.growth[i]! > 0) grown++
  }
  return { water, grown }
}
