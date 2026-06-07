export type PatchOp =
  | { type: "replace"; startLine: number; endLine: number; lines: string[] }
  | { type: "delete"; startLine: number; endLine: number }
  | { type: "insert"; position: "before" | "after"; lineNumber: number; lines: string[] }
  | { type: "insert"; position: "head" | "tail"; lines: string[] }

export interface HashlinePatch {
  path: string
  tag: string
  ops: PatchOp[]
}

const HEADER_PATTERN = /^\[([^#\]\n]+)#([0-9A-F]{4})\]$/
const REPLACE_PATTERN = /^replace\s+(\d+)\.\.(\d+)\s*:\s*$/
const DELETE_PATTERN = /^delete\s+(\d+)(?:\.\.(\d+))?\s*:?\s*$/
const INSERT_BEFORE_AFTER_PATTERN = /^insert\s+(?:(before|after)\s+(\d+)|(\d+)\s+(before|after))\s*:\s*$/
const INSERT_HEAD_TAIL_PATTERN = /^insert\s+(head|tail)\s*:\s*$/

function parseBody(lines: string[], cursor: { value: number }): string[] {
  const body: string[] = []
  while (cursor.value < lines.length) {
    const line = lines[cursor.value]
    if (isOperationHeader(line)) break
    if (line.trim() === "" && lines.slice(cursor.value).every((tailLine) => tailLine.trim() === "")) {
      cursor.value = lines.length
      break
    }
    if (!line.startsWith("+")) throw new Error(`Invalid hashline body row: ${line}. Body rows must start with +.`)
    body.push(line.slice(1))
    cursor.value++
  }
  return body
}

function isOperationHeader(line: string): boolean {
  return (
    REPLACE_PATTERN.test(line) ||
    DELETE_PATTERN.test(line) ||
    INSERT_BEFORE_AFTER_PATTERN.test(line) ||
    INSERT_HEAD_TAIL_PATTERN.test(line)
  )
}

function assertRange(startLine: number, endLine: number): void {
  if (startLine < 1 || endLine < 1) throw new Error("Hashline line numbers are 1-indexed and must be >= 1")
  if (endLine < startLine) throw new Error(`Invalid hashline range ${startLine}..${endLine}`)
}

export function parseHashlinePatch(input: string): HashlinePatch {
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimStart()
  const lines = normalized.split("\n")
  const header = lines[0]?.trimEnd() ?? ""
  const headerMatch = header.match(HEADER_PATTERN)
  if (!headerMatch) throw new Error("Invalid hashline header. Expected [path#TAG].")

  const ops: PatchOp[] = []
  const cursor = { value: 1 }
  while (cursor.value < lines.length) {
    const raw = lines[cursor.value]
    const line = raw.trimEnd()
    if (line.trim() === "") {
      cursor.value++
      continue
    }

    let match = line.match(REPLACE_PATTERN)
    if (match) {
      cursor.value++
      const startLine = Number(match[1])
      const endLine = Number(match[2])
      assertRange(startLine, endLine)
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`replace ${startLine}..${endLine} requires at least one + body row`)
      ops.push({ type: "replace", startLine, endLine, lines: body })
      continue
    }

    match = line.match(DELETE_PATTERN)
    if (match) {
      cursor.value++
      const startLine = Number(match[1])
      const endLine = Number(match[2] ?? match[1])
      assertRange(startLine, endLine)
      ops.push({ type: "delete", startLine, endLine })
      continue
    }

    match = line.match(INSERT_BEFORE_AFTER_PATTERN)
    if (match) {
      cursor.value++
      const position = (match[1] ?? match[4]) as "before" | "after"
      const lineNumber = Number(match[2] ?? match[3])
      if (lineNumber < 1) throw new Error("Hashline line numbers are 1-indexed and must be >= 1")
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`insert ${position} ${lineNumber} requires at least one + body row`)
      ops.push({ type: "insert", position, lineNumber, lines: body })
      continue
    }

    match = line.match(INSERT_HEAD_TAIL_PATTERN)
    if (match) {
      cursor.value++
      const position = match[1] as "head" | "tail"
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`insert ${position} requires at least one + body row`)
      ops.push({ type: "insert", position, lines: body })
      continue
    }

    throw new Error(`Invalid or unknown hashline operation: ${line}`)
  }

  if (ops.length === 0) throw new Error("Hashline patch must contain at least one operation")
  return { path: headerMatch[1], tag: headerMatch[2], ops }
}
