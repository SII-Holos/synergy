// Provenance: https://github.com/openai/codex/tree/160b2b1ef62114eeb41e41e5e3be0000d944b713/codex-rs/apply-patch/src
// Local adaptation: Codex parsing and ordered match tiers; preserve BOM and terminal-newline state. Execution stays with the selected Workspace.
// Copyright 2025 OpenAI. Derived portions are Apache-2.0; see ../LICENSE.codex and ../NOTICE.
export namespace FilePatch {
  export interface Hunk {
    anchor?: string
    rows: { kind: " " | "+" | "-"; text: string }[]
    eof: boolean
  }
  export type Section =
    | { type: "add"; path: string; content: string }
    | { type: "delete"; path: string }
    | { type: "update"; path: string; move?: string; hunks: Hunk[] }

  export class Invalid extends Error {
    override name = "InvalidFilePatch"
  }

  const whitespace = (text: string) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
  const trailingWhitespace = (text: string) => text.replace(/\p{White_Space}+$/gu, "")

  export function parse(text: string): Section[] {
    if (text.includes("\0") || !text.isWellFormed())
      throw new Invalid("Patch content must be valid Unicode text without NUL bytes.")
    let lines = whitespace(text).split(/\r?\n/)
    if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]!) && lines.at(-1)?.endsWith("EOF") && lines.length >= 4)
      lines = lines.slice(1, -1)
    if (whitespace(lines.shift() ?? "") !== "*** Begin Patch" || whitespace(lines.pop() ?? "") !== "*** End Patch")
      throw new Invalid("Expected one complete *** Begin Patch / *** End Patch document, without surrounding text.")
    const sections: Section[] = []
    const filename = (line: string, prefix: string) => {
      const value = line.slice(prefix.length)
      if (!value || /[\0\r\n]/.test(value))
        throw new Invalid("Patch paths must be nonempty and contain no NUL, CR or LF characters.")
      return value
    }
    let index = 0
    while (index < lines.length) {
      const line = whitespace(lines[index++]!)
      if (line.startsWith("*** Add File: ")) {
        const path = filename(line, "*** Add File: ")
        const rows: string[] = []
        while (lines[index]?.startsWith("+")) rows.push(lines[index++]!.slice(1))
        sections.push({ type: "add", path, content: rows.length ? `${rows.join("\n")}\n` : "" })
        continue
      }
      if (line.startsWith("*** Delete File: ")) {
        sections.push({ type: "delete", path: filename(line, "*** Delete File: ") })
        continue
      }
      if (!line.startsWith("*** Update File: "))
        throw new Invalid(`Unexpected patch line: ${line}. Expected an Add, Update or Delete File section.`)
      const section: Extract<Section, { type: "update" }> = {
        type: "update",
        path: filename(line, "*** Update File: "),
        hunks: [],
      }
      while (index < lines.length) {
        const row = lines[index]!
        const structural = trailingWhitespace(row)
        if (/^\*\*\* (?:Add File: |Update File: |Delete File: )/.test(structural)) break
        if (!section.hunks.length && !section.move && structural.startsWith("*** Move to: ")) {
          section.move = filename(structural, "*** Move to: ")
          index++
          continue
        }
        let hunk = section.hunks.at(-1)
        if (structural === "@@" || structural.startsWith("@@ ")) {
          if (hunk && !hunk.rows.length) throw new Invalid(`Empty hunk in ${section.path} at patch line ${index + 2}.`)
          section.hunks.push({ anchor: structural === "@@" ? undefined : structural.slice(3), rows: [], eof: false })
          index++
          continue
        }
        if (hunk?.eof && structural === "") {
          index++
          continue
        }
        if (structural === "*** End of File" && hunk?.rows.length) {
          hunk.eof = true
          index++
          continue
        }
        const kind = row === "" ? " " : row[0]
        if (hunk?.eof || (kind !== " " && kind !== "+" && kind !== "-"))
          throw new Invalid(
            `Invalid update row in ${section.path} at patch line ${index + 2}: ${row}. Use @@, context, +added or -removed lines.`,
          )
        if (!hunk) {
          hunk = { rows: [], eof: false }
          section.hunks.push(hunk)
        }
        hunk.rows.push({ kind, text: row.slice(1) })
        index++
      }
      if (section.hunks.some((hunk) => !hunk.rows.length)) throw new Invalid(`Empty update hunk in ${section.path}.`)
      if (!section.hunks.length && !section.move) throw new Invalid("An Update requires a hunk or Move to destination.")
      sections.push(section)
    }
    if (!sections.length) throw new Invalid("The patch contains no file sections.")
    return sections
  }

  export function paths(text: string): string[] {
    return parse(text).flatMap((section) =>
      section.type === "update" && section.move ? [section.path, section.move] : [section.path],
    )
  }

  function punctuation(text: string): string {
    return whitespace(text)
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/[\u2018-\u201b]/g, "'")
      .replace(/[\u201c-\u201f]/g, '"')
      .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ")
  }

  function seek(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
    if (!pattern.length) return start
    if (pattern.length > lines.length) return
    const first = eof ? Math.max(start, lines.length - pattern.length) : start
    for (const normalize of [(line: string) => line, trailingWhitespace, whitespace, punctuation]) {
      const expected = pattern.map(normalize)
      for (let index = first; index <= lines.length - pattern.length; index++)
        if (expected.every((line, offset) => normalize(lines[index + offset]!) === line)) return index
    }
  }

  export function update(content: string, section: Extract<Section, { type: "update" }>): string {
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : ""
    const body = content.slice(bom.length)
    const original: { text: string; ending: string }[] = []
    for (const match of body.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
      if (!match[0]) break
      original.push({ text: match[1]!, ending: match[2]! })
    }
    const ending = original.find((line) => line.ending)?.ending ?? "\n"
    const terminal = original.at(-1)?.ending !== "" && original.length > 0
    const lines = original.map((line) => line.text)
    const replacements: { start: number; length: number; lines: string[] }[] = []
    let cursor = 0
    for (const [index, hunk] of section.hunks.entries()) {
      let start = cursor
      const missing = (pattern: string[], anchor = false): never => {
        const earlier = seek(lines, pattern, 0, hunk.eof)
        const reason =
          earlier !== undefined && earlier < start
            ? `out-of-order or overlapping context at original line ${earlier + 1}; hunks must follow source order`
            : `no matching ${anchor ? "@@ anchor" : hunk.eof ? "end-of-file context" : "context"} at or after original line ${start + 1}`
        throw new Invalid(
          `Cannot apply hunk ${index + 1} in ${section.path}: ${reason}.\nExpected lines:\n${pattern.join("\n")}\nRead the affected range and correct this hunk.`,
        )
      }
      if (hunk.anchor !== undefined) {
        const anchor = seek(lines, [hunk.anchor], start, false)
        if (anchor === undefined) missing([hunk.anchor], true)
        start = anchor! + 1
      }
      const old = hunk.rows.filter((row) => row.kind !== "+").map((row) => row.text)
      const next = hunk.rows.filter((row) => row.kind !== "-").map((row) => row.text)
      if (!old.length) {
        replacements.push({ start: original.length, length: 0, lines: next })
        cursor = start
        continue
      }
      let pattern = old
      let added = next
      let position = seek(lines, pattern, start, hunk.eof)
      if (position === undefined && pattern.at(-1) === "") {
        pattern = pattern.slice(0, -1)
        if (added.at(-1) === "") added = added.slice(0, -1)
        position = seek(lines, pattern, start, hunk.eof)
      }
      if (position === undefined) missing(old)
      let source = 0
      let target = 0
      let oldStart = 0
      let newStart = 0
      for (const row of hunk.rows) {
        if (row.kind === " ") {
          if (source >= pattern.length || target >= added.length) break
          if (oldStart !== source || newStart !== target)
            replacements.push({
              start: position! + oldStart,
              length: source - oldStart,
              lines: added.slice(newStart, target),
            })
          oldStart = source + 1
          newStart = target + 1
        }
        if (row.kind !== "+") source++
        if (row.kind !== "-") target++
      }
      if (oldStart !== pattern.length || newStart !== added.length)
        replacements.push({
          start: position! + oldStart,
          length: pattern.length - oldStart,
          lines: added.slice(newStart),
        })
      cursor = position! + pattern.length
    }
    replacements.sort((a, b) => a.start - b.start)
    const result: typeof original = []
    cursor = 0
    for (const replacement of replacements) {
      if (replacement.start < cursor) throw new Invalid(`Overlapping replacements in ${section.path}.`)
      for (const line of original.slice(cursor, replacement.start)) result.push(line)
      for (const text of replacement.lines) result.push({ text, ending })
      cursor = replacement.start + replacement.length
    }
    for (const line of original.slice(cursor)) result.push(line)
    return (
      bom +
      result
        .map(
          (line, index) =>
            line.text + (index === result.length - 1 ? (terminal ? line.ending || ending : "") : line.ending || ending),
        )
        .join("")
    )
  }
}
