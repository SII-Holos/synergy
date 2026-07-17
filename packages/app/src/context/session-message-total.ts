export function nextMessageWindowTotal(input: { total: number; existing: boolean; visible: boolean }) {
  return input.total + (!input.existing && input.visible ? 1 : 0)
}
