export function isStaleMessageCursor(error: unknown) {
  return !!error && typeof error === "object" && "name" in error && error.name === "SessionMessagePageCursorStaleError"
}

export async function loadOlderOrRecoverLatest(input: {
  loadOlder: () => Promise<void>
  loadLatest: () => Promise<void>
}): Promise<"history" | "latest"> {
  try {
    await input.loadOlder()
    return "history"
  } catch (error) {
    if (!isStaleMessageCursor(error)) throw error
    await input.loadLatest()
    return "latest"
  }
}
