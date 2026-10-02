export type RoadKind = "road" | "corner" | "bridge"
export type Cell = { x: number; y: number }
export type Road = { kind: RoadKind; rotation: number }
export type Island = { roads: Record<string, Road>; night: boolean; progress: number }
export const islandCells = Array.from({ length: 35 }, (_, i) => ({ x: i % 7, y: Math.floor(i / 7) }))
export const cellKey = (x: number, y: number) => `${x},${y}`
const directions = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
]
const fixed = (x: number, y: number) => y === 2 && (x === 0 || x === 6)

export function createIsland(): Island {
  return {
    roads: Object.fromEntries([0, 1, 5, 6].map((x) => [cellKey(x, 2), { kind: "road", rotation: 0 }])),
    night: false,
    progress: 0,
  }
}

export function placeRoad(state: Island, x: number, y: number, kind: RoadKind): Island {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 6 || y < 0 || y > 4 || fixed(x, y)) return state
  if ((x === 3) !== (kind === "bridge")) return state
  return { ...state, progress: 0, roads: { ...state.roads, [cellKey(x, y)]: { kind, rotation: 0 } } }
}

export function rotateRoad(state: Island, x: number, y: number): Island {
  const key = cellKey(x, y)
  const road = state.roads[key]
  if (!road || fixed(x, y)) return state
  return { ...state, progress: 0, roads: { ...state.roads, [key]: { ...road, rotation: (road.rotation + 1) % 4 } } }
}

function exits(road: Road) {
  return (road.kind === "corner" ? [0, 1] : [1, 3]).map((direction) => (direction + road.rotation) % 4)
}

export function islandRoute(state: Pick<Island, "roads">): Cell[] {
  const queue: Cell[][] = [[{ x: 0, y: 2 }]]
  const visited = new Set(["0,2"])
  for (let i = 0; i < queue.length; i++) {
    const route = queue[i]!
    const cell = route[route.length - 1]!
    if (cell.x === 6 && cell.y === 2) return route
    const road = state.roads[cellKey(cell.x, cell.y)]
    if (!road) continue
    for (const direction of exits(road)) {
      const offset = directions[direction]!
      const next = { x: cell.x + offset.x, y: cell.y + offset.y }
      const key = cellKey(next.x, next.y)
      const neighbor = state.roads[key]
      if (visited.has(key) || !neighbor || !exits(neighbor).includes((direction + 2) % 4)) continue
      visited.add(key)
      queue.push([...route, next])
    }
  }
  return []
}

export function advanceCar(state: Island, seconds: number): Island {
  const route = islandRoute(state)
  if (!route.length || !Number.isFinite(seconds) || seconds <= 0) return state
  const progress = Math.min(route.length - 1, state.progress + seconds * 1.4)
  return progress === state.progress ? state : { ...state, progress }
}

export function projectCell(x: number, y: number) {
  return { x: 320 + (x - y) * 42, y: 82 + (x + y) * 21 }
}

export function unprojectCell(x: number, y: number): Cell {
  const horizontal = (x - 320) / 42
  const vertical = (y - 82) / 21
  return { x: Math.round((vertical + horizontal) / 2), y: Math.round((vertical - horizontal) / 2) }
}
