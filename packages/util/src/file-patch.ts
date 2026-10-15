// Provenance: https://github.com/openai/codex/blob/2f05c0a71f59fb2f05800846351f3e9926c3e52b/codex-rs/core/src/tools/handlers/apply_patch.rs
// Local adaptation: patch language only; complete strict parsing, unique exact spans and byte-preserving text edits. No execution backend.
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

  export function parse(text: string): Section[] {
    if (text.includes("\0") || !text.isWellFormed())
      throw new Invalid("Patch content must be valid Unicode text without NUL bytes.")
    const lines = text.split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
    if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch")
      throw new Invalid("Expected one complete *** Begin Patch / *** End Patch document, without surrounding text.")
    const sections: Section[] = []
    const filename = (line: string, prefix: string) => {
      const value = line.slice(prefix.length)
      if (!value || value !== value.trim() || /[\0\r\n]/.test(value))
        throw new Invalid("Patch paths must be nonempty and have no surrounding whitespace or control characters.")
      return value
    }
    let index = 0
    while (index < lines.length) {
      const line = lines[index++]!
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
      if (lines[index]?.startsWith("*** Move to: ")) section.move = filename(lines[index++]!, "*** Move to: ")
      while (lines[index] === "@@" || lines[index]?.startsWith("@@ ")) {
        const header = lines[index++]!
        const hunk: Hunk = { anchor: header === "@@" ? undefined : header.slice(3), rows: [], eof: false }
        while (index < lines.length) {
          const row = lines[index]!
          if (row === "*** End of File") {
            hunk.eof = true
            index++
            break
          }
          const kind = row[0]
          if (kind !== " " && kind !== "+" && kind !== "-") break
          hunk.rows.push({ kind, text: row.slice(1) })
          index++
        }
        if (!hunk.rows.length) throw new Invalid("An Update hunk must contain context or changed lines.")
        if (hunk.eof && (lines[index] === "@@" || lines[index]?.startsWith("@@ ")))
          throw new Invalid("*** End of File is allowed only in the final hunk.")
        if (!hunk.rows.some((row) => row.kind !== "+") && !hunk.eof)
          throw new Invalid("An insertion without original context requires *** End of File.")
        section.hunks.push(hunk)
      }
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

  export function update(content: string, section: Extract<Section, { type: "update" }>): string {
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : ""
    const body = content.slice(bom.length)
    const original: { text: string; ending: string }[] = []
    const matcher = /([^\r\n]*)(\r\n|\n|\r|$)/g
    for (const match of body.matchAll(matcher)) {
      if (!match[0]) break
      original.push({ text: match[1]!, ending: match[2]! })
    }
    const ending = original.find((line) => line.ending)?.ending ?? "\n"
    const terminal = original.at(-1)?.ending !== "" && original.length > 0
    const result: typeof original = []
    let cursor = 0
    for (const hunk of section.hunks) {
      let start = cursor
      if (hunk.anchor !== undefined) {
        const anchors = original.flatMap((line, i) => (line.text === hunk.anchor ? [i] : []))
        if (anchors.length !== 1)
          throw new Invalid(`Missing or ambiguous @@ anchor in ${section.path}. Include unique exact context.`)
        start = anchors[0]! + 1
        if (start < cursor) throw new Invalid(`Overlapping or out-of-order hunks in ${section.path}.`)
      }
      const old = hunk.rows.filter((row) => row.kind !== "+").map((row) => row.text)
      const matches: number[] = []
      if (!old.length) {
        if (!hunk.eof) throw new Invalid("Context-free insertion requires an explicit EOF marker.")
        matches.push(original.length)
      } else {
        for (let i = start; i <= original.length - old.length; i++) {
          if (hunk.eof && i + old.length !== original.length) continue
          if (old.every((line, offset) => original[i + offset]!.text === line)) matches.push(i)
        }
      }
      if (matches.length !== 1)
        throw new Invalid(
          `Missing or ambiguous exact hunk context in ${section.path}. Read the file and include unique original lines.`,
        )
      const position = matches[0]!
      if (position < cursor) throw new Invalid(`Overlapping hunks in ${section.path}.`)
      result.push(...original.slice(cursor, position))
      let source = position
      for (const row of hunk.rows) {
        if (row.kind === " ") result.push(original[source++]!)
        else if (row.kind === "-") source++
        else result.push({ text: row.text, ending })
      }
      cursor = position + old.length
    }
    result.push(...original.slice(cursor))
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
