export const sceneStep = 1 / 120

export function advanceFixed<T extends { remainder: number }>(
  state: T,
  seconds: number,
  update: (state: T, dt: number) => T,
): T {
  if (seconds <= 0 || !Number.isFinite(seconds)) return state
  const elapsed = state.remainder + Math.min(seconds, 0.1)
  const count = Math.min(12, Math.floor((elapsed + 1e-9) / sceneStep))
  const remainder = Math.max(0, elapsed - count * sceneStep)
  let next = state
  for (let i = 0; i < count; i++) next = update(next, sceneStep)
  return { ...next, remainder: remainder < 1e-9 ? 0 : remainder }
}
