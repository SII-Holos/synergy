export function questionOptionShortcutIndex(input: {
  key: string
  optionCount: number
  modified?: boolean
  editable?: boolean
}) {
  if (input.modified || input.editable || !/^[1-9]$/.test(input.key)) return
  const index = Number(input.key) - 1
  if (index >= input.optionCount) return
  return index
}
