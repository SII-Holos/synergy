export const errorUnknownDescriptor = { id: "ui.errorCard.unknownError", message: "Unknown error" }

export function errorPreview(error: string) {
  const line = error
    .replace(/^error:\s*/i, "")
    .split(/\r?\n/)
    .find((item) => item.trim().length > 0)

  return line?.trim() || "Unknown error"
}

export function errorInputText(input?: Record<string, unknown>) {
  return input ? JSON.stringify(input, null, 2) : undefined
}

export function errorDetailsText(error: string, input?: Record<string, unknown>) {
  const inputText = errorInputText(input)
  return inputText ? `${error}\n\nInput:\n${inputText}` : error
}
