export type KeyInput = {
  name: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

export type KeyContext = {
  modalOpen: boolean
  composerFocused: boolean
  sessionActive: boolean
  sessionBusy: boolean
}

export type KeyCommand =
  | "abort-session"
  | "blur-composer"
  | "create-session"
  | "dismiss-modal"
  | "focus-next"
  | "focus-previous"
  | "history-next"
  | "history-previous"
  | "insert-newline"
  | "open-command-palette"
  | "quit"
  | "send-input"
  | "toggle-pin"

function exactModifier(key: KeyInput, modifier: "ctrl" | "shift") {
  return key[modifier] === true && !key.alt && !key.meta && (modifier === "ctrl" || !key.ctrl)
}

export function resolveKeyCommand(key: KeyInput, context: KeyContext): KeyCommand | undefined {
  if (key.name === "escape" && !key.ctrl && !key.alt && !key.meta) {
    if (context.modalOpen) return "dismiss-modal"
    if (context.composerFocused) return "blur-composer"
    return undefined
  }

  if (key.name === "c" && exactModifier(key, "ctrl")) {
    if (context.sessionActive && context.sessionBusy) return "abort-session"
    return "quit"
  }
  if (key.name === "n" && exactModifier(key, "ctrl")) return "create-session"
  if (key.name === "p" && exactModifier(key, "ctrl") && context.sessionActive) return "toggle-pin"
  if (key.name === "k" && exactModifier(key, "ctrl")) return "open-command-palette"

  if (key.name === "tab" && !key.ctrl && !key.alt && !key.meta) {
    return key.shift ? "focus-previous" : "focus-next"
  }

  if (!context.composerFocused || key.ctrl || key.alt || key.meta) return undefined
  if (key.name === "return") return key.shift ? "insert-newline" : "send-input"
  if (key.name === "up" && !key.shift) return "history-previous"
  if (key.name === "down" && !key.shift) return "history-next"
  return undefined
}
