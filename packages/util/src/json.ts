export function parsePartialJson(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw)
  } catch {}

  let text = raw
  if (/(?:^|[^\\])\\$/.test(text)) {
    text = text.slice(0, -1)
  }

  const stack: string[] = []
  let inString = false
  let escaped = false
  let depth = 0
  let afterColon = false
  let lastSafeEnd = -1

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') {
      if (inString) {
        inString = false
        if (afterColon && depth === 1) {
          lastSafeEnd = i + 1
          afterColon = false
        }
      } else {
        inString = true
      }
      continue
    }
    if (inString) continue

    if (char === "{") {
      depth++
      stack.push("}")
    } else if (char === "[") {
      depth++
      stack.push("]")
    } else if (char === "}" || char === "]") {
      depth--
      stack.pop()
      if (afterColon && depth === 1) {
        lastSafeEnd = i + 1
        afterColon = false
      }
    } else if (char === ":" && depth === 1) {
      afterColon = true
    } else if (char === "," && depth === 1) {
      lastSafeEnd = i
      afterColon = false
    } else if (afterColon && depth === 1 && !/\s/.test(char)) {
      let end = i
      while (end + 1 < text.length && /[^\s,}\]]/.test(text[end + 1])) end++
      const token = text.slice(i, end + 1)
      if (/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) {
        lastSafeEnd = end + 1
        afterColon = false
        i = end
      }
    }
  }

  const result = closeAndParse(text, inString, stack)
  if (result !== undefined) return result

  if (lastSafeEnd > 0) {
    let safe = text.slice(0, lastSafeEnd).replace(/,\s*$/, "")
    const safeStack: string[] = []
    let s = false
    let e = false
    for (let i = 0; i < safe.length; i++) {
      const c = safe[i]
      if (e) {
        e = false
        continue
      }
      if (c === "\\") {
        e = true
        continue
      }
      if (c === '"') {
        s = !s
        continue
      }
      if (s) continue
      if (c === "{") safeStack.push("}")
      if (c === "[") safeStack.push("]")
      if (c === "}" || c === "]") safeStack.pop()
    }
    while (safeStack.length) safe += safeStack.pop()

    try {
      const result = JSON.parse(safe)
      if (typeof result === "object" && result !== null) return result
    } catch {}
  }

  return {}
}

function closeAndParse(text: string, inString: boolean, stack: string[]): Record<string, any> | undefined {
  let base = text
  if (inString) base += '"'

  {
    let closed = base
    const s = [...stack]
    while (s.length) closed += s.pop()
    try {
      const result = JSON.parse(closed)
      if (typeof result === "object" && result !== null) return result
    } catch {}
  }

  let trimmed = base
  for (let attempt = 0; attempt < 10; attempt++) {
    const lastCut = findLastCutPoint(trimmed)
    if (lastCut < 0) break

    trimmed = trimmed.slice(0, lastCut).replace(/[,:\s]+$/, "")
    const closed = trimmed + computeClosers(trimmed)

    try {
      const result = JSON.parse(closed)
      if (typeof result === "object" && result !== null) return result
    } catch {}
  }

  return undefined
}

function findLastCutPoint(text: string): number {
  let inStr = false
  let esc = false
  let lastComma = -1
  let lastOpen = -1

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === "\\") {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === ",") lastComma = i
    if (c === "[" || c === "{") lastOpen = i
  }

  return lastComma > lastOpen ? lastComma : lastOpen > 0 ? lastOpen + 1 : -1
}

function computeClosers(text: string): string {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === "\\") {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === "{") stack.push("}")
    if (c === "[") stack.push("]")
    if (c === "}" || c === "]") stack.pop()
  }
  let result = ""
  while (stack.length) result += stack.pop()
  return result
}
