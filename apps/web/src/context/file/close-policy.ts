export async function canLeaveFileDocument(input: {
  dirty: () => boolean
  draft: () => { content: string; revision: number } | undefined
  choose: () => Promise<"save" | "discard" | "cancel">
  save: (content: string) => Promise<unknown>
  discard: () => void
}) {
  if (!input.dirty()) return true
  const captured = input.draft()
  if (!captured) return false
  const choice = await input.choose()
  if (choice === "cancel" || input.draft()?.revision !== captured.revision) return false
  if (choice === "save") await input.save(captured.content)
  else input.discard()
  return !input.dirty()
}
