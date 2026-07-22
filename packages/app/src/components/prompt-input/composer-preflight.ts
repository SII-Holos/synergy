type ComposerPreflightInput = {
  beforeSubmit: () => Promise<void>
  restore: () => void
  onNonAbortError: (error: unknown) => void
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

export async function runComposerPreflight(input: ComposerPreflightInput): Promise<boolean> {
  try {
    await input.beforeSubmit()
    return true
  } catch (error) {
    input.restore()
    if (!isAbortError(error)) input.onNonAbortError(error)
    return false
  }
}
