export namespace ExecutionJson {
  export type Section = {
    path: string[]
    kind: "object" | "array" | "string" | "number" | "boolean" | "null"
    offset: number
    bytes: number
    role?: string
    preview: string
  }
  type Frame = {
    path: string[]
    kind: "object" | "array"
    start: number
    state: "key" | "colon" | "value" | "comma"
    empty: boolean
    key?: string
    index: number
    role?: string
  }
  type Token = {
    start: number
    path: string[]
    key: boolean
    kind: "string" | "scalar"
    escaped: boolean
    unicode: number
    sample: number[]
    overflow: boolean
  }

  export async function index(source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    const stack: Frame[] = []
    const items: Section[] = []
    let token: Token | undefined
    let offset = 0
    let done = false
    let truncated = false
    let indexBytes = 0
    const utf8 = new TextDecoder("utf-8", { fatal: true })
    const invalid = () => {
      throw new SyntaxError("Execution content is not complete JSON")
    }
    const path = () => {
      const parent = stack.at(-1)
      if (!parent) return []
      return [...parent.path, parent.kind === "array" ? String(parent.index) : parent.key!]
    }
    const finishValue = () => {
      const parent = stack.at(-1)
      if (!parent) {
        done = true
        return
      }
      if (parent.state !== "value") invalid()
      parent.state = "comma"
      parent.empty = false
      parent.index++
    }
    const sectionBytes = (value: Section) =>
      96 + value.path.reduce((sum, key) => sum + key.length * 4, 0) + value.preview.length * 4
    const section = (value: Section) => {
      if (value.path.length > 2) return
      const bytes = sectionBytes(value)
      while (value.path.length <= 1 && (items.length >= 10_000 || indexBytes + bytes > 2 * 1024 * 1024)) {
        const index = items.findLastIndex((item) => item.path.length > 1)
        if (index < 0) break
        indexBytes -= sectionBytes(items[index])
        items.splice(index, 1)
        truncated = true
      }
      if (items.length >= 10_000 || indexBytes + bytes > 2 * 1024 * 1024) {
        truncated = true
        return
      }
      indexBytes += bytes
      items.push(value)
    }
    const finishToken = (end: number) => {
      const current = token!
      const raw = Buffer.from(current.sample).toString()
      if (current.key) {
        if (current.overflow) throw new RangeError("Execution JSON key exceeds the section index budget")
        stack.at(-1)!.key = JSON.parse(raw)
        stack.at(-1)!.state = "colon"
      } else {
        let kind: Section["kind"] = "string"
        let preview = ""
        if (current.kind === "scalar") {
          if (current.overflow || !/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(raw))
            invalid()
          kind = raw === "null" ? "null" : raw === "true" || raw === "false" ? "boolean" : "number"
          preview = raw
        } else if (!current.overflow) {
          const value: unknown = JSON.parse(raw)
          if (typeof value === "string") preview = value.slice(0, 160)
          if (current.path.at(-1) === "role" && typeof value === "string") stack.at(-1)!.role = value.slice(0, 64)
        }
        section({ path: current.path, kind, offset: current.start, bytes: end - current.start, preview })
        finishValue()
      }
      token = undefined
    }
    const sample = (byte: number) => {
      const current = token!
      const budget = current.key ? 65_536 : current.kind === "scalar" ? 1024 : 512
      if (current.sample.length < budget) current.sample.push(byte)
      else current.overflow = true
    }
    const consume = (byte: number): boolean => {
      if (token) {
        if (token.kind === "scalar") {
          if (byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === 44 || byte === 93 || byte === 125) {
            finishToken(offset)
            return false
          }
          sample(byte)
          return true
        }
        sample(byte)
        if (token.unicode) {
          if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) invalid()
          token.unicode--
        } else if (token.escaped) {
          if (byte === 117) token.unicode = 4
          else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) invalid()
          token.escaped = false
        } else if (byte === 92) token.escaped = true
        else if (byte === 34) finishToken(offset + 1)
        else if (byte < 32) invalid()
        return true
      }
      if (byte === 32 || byte === 9 || byte === 10 || byte === 13) return true
      if (done) invalid()
      const parent = stack.at(-1)
      if (byte === 125 || byte === 93) {
        if (
          !parent ||
          parent.kind !== (byte === 125 ? "object" : "array") ||
          !(parent.state === "comma" || (parent.empty && parent.state === (parent.kind === "object" ? "key" : "value")))
        )
          invalid()
        const frame = stack.pop()!
        section({
          path: frame.path,
          kind: frame.kind,
          offset: frame.start,
          bytes: offset + 1 - frame.start,
          role: frame.role,
          preview: "",
        })
        finishValue()
        return true
      }
      if (parent?.state === "comma") {
        if (byte !== 44) invalid()
        parent.state = parent.kind === "object" ? "key" : "value"
        return true
      }
      if (parent?.state === "colon") {
        if (byte !== 58) invalid()
        parent.state = "value"
        return true
      }
      if (parent?.state === "key") {
        if (byte !== 34) invalid()
        token = {
          start: offset,
          path: parent.path,
          kind: "string",
          key: true,
          escaped: false,
          unicode: 0,
          sample: [byte],
          overflow: false,
        }
        return true
      }
      if (parent && parent.state !== "value") invalid()
      const currentPath = path()
      if (byte === 123 || byte === 91) {
        if (stack.length >= 128) throw new RangeError("Execution JSON nesting exceeds the section index budget")
        stack.push({
          path: currentPath,
          kind: byte === 123 ? "object" : "array",
          start: offset,
          state: byte === 123 ? "key" : "value",
          empty: true,
          index: 0,
        })
      } else if (byte === 34) {
        token = {
          start: offset,
          path: currentPath,
          kind: "string",
          key: false,
          escaped: false,
          unicode: 0,
          sample: [byte],
          overflow: false,
        }
      } else {
        if (!(byte === 45 || (byte >= 48 && byte <= 57) || byte === 116 || byte === 102 || byte === 110)) invalid()
        token = {
          start: offset,
          path: currentPath,
          kind: "scalar",
          key: false,
          escaped: false,
          unicode: 0,
          sample: [byte],
          overflow: false,
        }
      }
      return true
    }
    for await (const chunk of source) {
      signal?.throwIfAborted()
      utf8.decode(chunk, { stream: true })
      for (const byte of chunk) {
        while (!consume(byte)) {}
        offset++
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    utf8.decode()
    if (token?.kind === "scalar") finishToken(offset)
    if (token || stack.length || !done) invalid()
    return { items: items.toSorted((a, b) => a.offset - b.offset || b.bytes - a.bytes), truncated }
  }
}
