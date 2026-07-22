export type InputHistory = {
  entries(): readonly string[]
  record(value: string): void
  previous(draft: string): string | undefined
  next(): string | undefined
  resetNavigation(): void
}

export function createInputHistory(limit = 100): InputHistory {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("history limit must be a positive integer")

  const values: string[] = []
  let cursor: number | undefined
  let draft: string | undefined

  const resetNavigation = () => {
    cursor = undefined
    draft = undefined
  }

  return {
    entries() {
      return values.slice()
    },
    record(value) {
      const normalized = value.trim()
      resetNavigation()
      if (!normalized || values.at(-1) === normalized) return
      values.push(normalized)
      if (values.length > limit) values.splice(0, values.length - limit)
    },
    previous(currentDraft) {
      if (values.length === 0) return undefined
      if (cursor === undefined) {
        draft = currentDraft
        cursor = values.length - 1
        return values[cursor]
      }
      cursor = Math.max(0, cursor - 1)
      return values[cursor]
    },
    next() {
      if (cursor === undefined) return undefined
      if (cursor < values.length - 1) {
        cursor++
        return values[cursor]
      }
      const restored = draft ?? ""
      resetNavigation()
      return restored
    },
    resetNavigation,
  }
}
