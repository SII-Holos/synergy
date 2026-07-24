const ESC = 0x1b
const C1_CSI = 0x9b
const C1_ST = 0x9c
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

function skipStringControl(input: string, start: number, bellTerminates: boolean) {
  for (let index = start; index < input.length; index++) {
    const code = input.charCodeAt(index)
    if (bellTerminates && code === 0x07) return index + 1
    if (code === C1_ST) return index + 1
    if (code === ESC && input.charCodeAt(index + 1) === 0x5c) return index + 2
  }
  return input.length
}

function skipCsi(input: string, start: number) {
  for (let index = start; index < input.length; index++) {
    const code = input.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
  }
  return input.length
}

export function sanitizeTerminalText(input: string): string {
  let output = ""
  let index = 0
  while (index < input.length) {
    const code = input.charCodeAt(index)

    if (code === ESC) {
      const next = input.charCodeAt(index + 1)
      if (next === 0x5b) {
        index = skipCsi(input, index + 2)
        continue
      }
      if (next === 0x5d) {
        index = skipStringControl(input, index + 2, true)
        continue
      }
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipStringControl(input, index + 2, false)
        continue
      }
      index = Math.min(input.length, index + 2)
      continue
    }

    if (code === C1_CSI) {
      index = skipCsi(input, index + 1)
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = skipStringControl(input, index + 1, code === 0x9d)
      continue
    }

    if (code === 0x0a || code === 0x09) {
      output += input[index]
      index++
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index++
      continue
    }

    if (BIDI_CONTROLS.test(input[index] ?? "")) {
      index++
      continue
    }

    output += input[index]
    index++
  }
  return output
}

export function sanitizeTerminalLine(input: string): string {
  return sanitizeTerminalText(input)
    .replace(/[\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function sanitizeTerminalLabel(input: string, fallback: string): string {
  const label = sanitizeTerminalLine(input)
  if (label) return label
  return sanitizeTerminalLine(fallback) || "unnamed"
}
