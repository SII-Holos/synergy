export type PatchOp =
  | { type: "replace"; startLine: number; endLine: number; lines: string[] }
  | { type: "delete"; startLine: number; endLine: number }
  | { type: "insert"; position: "before" | "after"; lineNumber: number; lines: string[] }
  | { type: "insert"; position: "head" | "tail"; lines: string[] }
  | { type: "blockSwap"; blockRef: string; lines: string[] }

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
const OMP_SWAP_PATTERN = /^SWAP\s+(\d+)\.\.(\d+)\s*:\s*$/
const OMP_SWAP_EQ_PATTERN = /^SWAP\s+(\d+)\.=(\d+)\s*:\s*$/
const OMP_DEL_PATTERN = /^DEL\s+(\d+)(?:\.\.(\d+))?\s*:?\s*$/
const OMP_INS_PRE_PATTERN = /^INS\.PRE\s+(\d+)\s*:\s*$/
const OMP_INS_POST_PATTERN = /^INS\.POST\s+(\d+)\s*:\s*$/
const OMP_INS_HEAD_PATTERN = /^INS\.HEAD\s*:\s*$/
const OMP_INS_TAIL_PATTERN = /^INS\.TAIL\s*:\s*$/
const OMP_SWAP_BLK_PATTERN = /^SWAP\.BLK\s+(\S[^\n:]*)\s*:\s*$/

function parseBody(lines: string[], cursor: { value: number }): string[] {
  const body: string[] = []
  while (cursor.value < lines.length) {
    const line = lines[cursor.value]
    if (isOperationHeader(line)) break
    if (line.trim() === "" && lines.slice(cursor.value).every((tailLine) => tailLine.trim() === "")) {
      cursor.value = lines.length
      break
    }
    if (!line.startsWith("+")) throw new Error(`Invalid patch body row: ${line}. Body rows must start with +.`)
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
    INSERT_HEAD_TAIL_PATTERN.test(line) ||
    OMP_SWAP_PATTERN.test(line) ||
    OMP_SWAP_EQ_PATTERN.test(line) ||
    OMP_DEL_PATTERN.test(line) ||
    OMP_INS_PRE_PATTERN.test(line) ||
    OMP_INS_POST_PATTERN.test(line) ||
    OMP_INS_HEAD_PATTERN.test(line) ||
    OMP_INS_TAIL_PATTERN.test(line) ||
    OMP_SWAP_BLK_PATTERN.test(line)
  )
}

function assertRange(startLine: number, endLine: number): void {
  if (startLine < 1 || endLine < 1) throw new Error("Patch line numbers are 1-indexed and must be >= 1")
  if (endLine < startLine) throw new Error(`Invalid patch range ${startLine}..${endLine}`)
}

export function parseHashlinePatch(input: string): HashlinePatch {
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimStart()
  const lines = normalized.split("\n")
  const header = lines[0]?.trimEnd() ?? ""
  const headerMatch = header.match(HEADER_PATTERN)
  if (!headerMatch) throw new Error("Invalid patch header. Expected [path#TAG].")

  const ops: PatchOp[] = []
  const cursor = { value: 1 }
  while (cursor.value < lines.length) {
    const raw = lines[cursor.value]
    const line = raw.trimEnd()
    if (line.trim() === "") {
      cursor.value++
      continue
    }

    let match: RegExpMatchArray | null

    match = line.match(REPLACE_PATTERN)
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
      if (lineNumber < 1) throw new Error("Patch line numbers are 1-indexed and must be >= 1")
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

    match = line.match(OMP_SWAP_PATTERN)
    if (match) {
      cursor.value++
      const startLine = Number(match[1])
      const endLine = Number(match[2])
      assertRange(startLine, endLine)
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`SWAP ${startLine}..${endLine} requires at least one + body row`)
      ops.push({ type: "replace", startLine, endLine, lines: body })
      continue
    }

    match = line.match(OMP_SWAP_EQ_PATTERN)
    if (match) {
      cursor.value++
      const startLine = Number(match[1])
      const endLine = Number(match[2])
      assertRange(startLine, endLine)
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`SWAP ${startLine}.=${endLine} requires at least one + body row`)
      ops.push({ type: "replace", startLine, endLine, lines: body })
      continue
    }

    match = line.match(OMP_DEL_PATTERN)
    if (match) {
      cursor.value++
      const startLine = Number(match[1])
      const endLine = Number(match[2] ?? match[1])
      assertRange(startLine, endLine)
      ops.push({ type: "delete", startLine, endLine })
      continue
    }

    match = line.match(OMP_INS_PRE_PATTERN)
    if (match) {
      cursor.value++
      const lineNumber = Number(match[1])
      if (lineNumber < 1) throw new Error("Patch line numbers are 1-indexed and must be >= 1")
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`INS.PRE ${lineNumber} requires at least one + body row`)
      ops.push({ type: "insert", position: "before", lineNumber, lines: body })
      continue
    }

    match = line.match(OMP_INS_POST_PATTERN)
    if (match) {
      cursor.value++
      const lineNumber = Number(match[1])
      if (lineNumber < 1) throw new Error("Patch line numbers are 1-indexed and must be >= 1")
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`INS.POST ${lineNumber} requires at least one + body row`)
      ops.push({ type: "insert", position: "after", lineNumber, lines: body })
      continue
    }

    match = line.match(OMP_INS_HEAD_PATTERN)
    if (match) {
      cursor.value++
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error("INS.HEAD requires at least one + body row")
      ops.push({ type: "insert", position: "head", lines: body })
      continue
    }

    match = line.match(OMP_INS_TAIL_PATTERN)
    if (match) {
      cursor.value++
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error("INS.TAIL requires at least one + body row")
      ops.push({ type: "insert", position: "tail", lines: body })
      continue
    }

    match = line.match(OMP_SWAP_BLK_PATTERN)
    if (match) {
      cursor.value++
      const blockRef = match[1].trimEnd()
      if (!blockRef) throw new Error("SWAP.BLK requires a block reference name")
      const body = parseBody(lines, cursor)
      if (body.length === 0) throw new Error(`SWAP.BLK ${blockRef} requires at least one + body row`)
      ops.push({ type: "blockSwap", blockRef, lines: body })
      continue
    }

    throw new Error(`Invalid or unknown patch operation: ${line}`)
  }

  if (ops.length === 0) throw new Error("Patch must contain at least one operation")
  return { path: headerMatch[1], tag: headerMatch[2], ops }
}
