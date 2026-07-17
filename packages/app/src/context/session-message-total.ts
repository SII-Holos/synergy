export function nextMessageWindowTotal(input: { total: number; existing: boolean; visible: boolean }) {
  return input.total + (!input.existing && input.visible ? 1 : 0)
}

export function nextMessageWindowTotalAfterRemoval(input: { total: number; pending: boolean }) {
  return Math.max(0, input.total - (input.pending ? 0 : 1))
}
