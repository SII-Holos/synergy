const ESC = "\x1b"
const CR = "\r"
const TAB = "\t"
const BACKSPACE = "\x7f"

const namedKeyMap = new Map<string, string>([
  ["enter", CR],
  ["return", CR],
  ["tab", TAB],
  ["escape", ESC],
  ["esc", ESC],
  ["space", " "],
  ["bspace", BACKSPACE],
  ["backspace", BACKSPACE],
  ["up", `${ESC}[A`],
  ["down", `${ESC}[B`],
  ["right", `${ESC}[C`],
  ["left", `${ESC}[D`],
  ["home", `${ESC}[1~`],
  ["end", `${ESC}[4~`],
  ["pageup", `${ESC}[5~`],
  ["pagedown", `${ESC}[6~`],
  ["insert", `${ESC}[2~`],
  ["delete", `${ESC}[3~`],
  ["f1", `${ESC}OP`],
  ["f2", `${ESC}OQ`],
  ["f3", `${ESC}OR`],
  ["f4", `${ESC}OS`],
  ["f5", `${ESC}[15~`],
  ["f6", `${ESC}[17~`],
  ["f7", `${ESC}[18~`],
  ["f8", `${ESC}[19~`],
  ["f9", `${ESC}[20~`],
  ["f10", `${ESC}[21~`],
  ["f11", `${ESC}[23~`],
  ["f12", `${ESC}[24~`],
])

interface Modifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export interface KeyEncodingResult {
  data: string
  warnings: string[]
}

export function encodeKeySequence(keys: string[]): KeyEncodingResult {
  const warnings: string[] = []
  let data = ""

  for (const token of keys) {
    data += encodeKeyToken(token, warnings)
  }

  return { data, warnings }
}

function encodeKeyToken(raw: string, warnings: string[]): string {
  const token = raw.trim()
  if (!token) return ""

  // Handle ^X notation for Ctrl
  if (token.length === 2 && token.startsWith("^")) {
    const ctrl = toCtrlChar(token[1])
    if (ctrl) return ctrl
  }

  const parsed = parseModifiers(token)
  const base = parsed.base
  const baseLower = base.toLowerCase()

  // Handle Shift+Tab
  if (baseLower === "tab" && parsed.mods.shift) {
    return `${ESC}[Z`
  }

  // Check named keys
  const baseSeq = namedKeyMap.get(baseLower)
  if (baseSeq) {
    if (parsed.mods.alt) {
      return `${ESC}${baseSeq}`
    }
    return baseSeq
  }

  // Single character with modifiers
  if (base.length === 1) {
    return applyCharModifiers(base, parsed.mods)
  }

  if (parsed.hasModifiers) {
    warnings.push(`Unknown key "${base}" for modifiers; sending literal.`)
  }
  return base
}

function parseModifiers(token: string) {
  const mods: Modifiers = { ctrl: false, alt: false, shift: false }
  let rest = token
  let sawModifiers = false

  while (rest.length > 2 && rest[1] === "-") {
    const mod = rest[0].toLowerCase()
    if (mod === "c") {
      mods.ctrl = true
    } else if (mod === "m") {
      mods.alt = true
    } else if (mod === "s") {
      mods.shift = true
    } else {
      break
    }
    sawModifiers = true
    rest = rest.slice(2)
  }

  return { mods, base: rest, hasModifiers: sawModifiers }
}

function applyCharModifiers(char: string, mods: Modifiers): string {
  let value = char
  if (mods.shift && value.length === 1 && /[a-z]/.test(value)) {
    value = value.toUpperCase()
  }
  if (mods.ctrl) {
    const ctrl = toCtrlChar(value)
    if (ctrl) value = ctrl
  }
  if (mods.alt) {
    value = `${ESC}${value}`
  }
  return value
}

function toCtrlChar(char: string): string | null {
  if (char.length !== 1) return null
  if (char === "?") return "\x7f"
  const code = char.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) {
    return String.fromCharCode(code & 0x1f)
  }
  return null
}
