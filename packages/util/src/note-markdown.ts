export namespace NoteMarkdown {
  interface TipTapNode {
    type: string
    attrs?: Record<string, any>
    content?: TipTapNode[]
    text?: string
    marks?: Array<{ type: string; attrs?: Record<string, any> }>
  }

  function renderMarks(text: string, marks?: TipTapNode["marks"]): string {
    if (!marks || marks.length === 0) return text
    let result = text
    for (const mark of marks) {
      switch (mark.type) {
        case "bold":
          result = `**${result}**`
          break
        case "italic":
          result = `*${result}*`
          break
        case "code":
          result = `\`${result}\``
          break
        case "strike":
          result = `~~${result}~~`
          break
        case "link":
          result = `[${result}](${mark.attrs?.href ?? ""})`
          break
      }
    }
    return result
  }

  function renderInline(nodes: TipTapNode[]): string {
    let result = ""
    for (const node of nodes) {
      if (node.type === "text") {
        result += renderMarks(node.text ?? "", node.marks)
      } else if (node.type === "hardBreak") {
        result += "\n"
      } else if (node.type === "image") {
        const alt = node.attrs?.alt ?? ""
        const src = node.attrs?.src ?? ""
        result += `![${alt}](${src})`
      }
    }
    return result
  }

  function renderBlock(node: TipTapNode, indent: string = ""): string {
    switch (node.type) {
      case "doc":
        return renderChildren(node.content ?? [])

      case "paragraph":
        return indent + renderInline(node.content ?? [])

      case "heading": {
        const level = node.attrs?.level ?? 1
        const prefix = "#".repeat(level)
        return `${prefix} ${renderInline(node.content ?? [])}`
      }

      case "bulletList":
        return (node.content ?? []).map((item) => renderListItem(item, indent, "- ")).join("\n")

      case "orderedList":
        return (node.content ?? []).map((item, i) => renderListItem(item, indent, `${i + 1}. `)).join("\n")

      case "taskList":
        return (node.content ?? []).map((item) => renderTaskItem(item, indent)).join("\n")

      case "codeBlock": {
        const lang = node.attrs?.language ?? ""
        const code = renderInline(node.content ?? [])
        return `\`\`\`${lang}\n${code}\n\`\`\``
      }

      case "blockquote":
        return (node.content ?? [])
          .map((child) => renderBlock(child))
          .join("\n")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")

      case "horizontalRule":
        return "---"

      case "image": {
        const alt = node.attrs?.alt ?? ""
        const src = node.attrs?.src ?? ""
        return `![${alt}](${src})`
      }

      case "table":
        return renderTable(node)

      default:
        if (node.content) return renderChildren(node.content)
        if (node.text) return renderMarks(node.text, node.marks)
        return ""
    }
  }

  function renderListItem(node: TipTapNode, indent: string, bullet: string): string {
    const children = node.content ?? []
    const lines: string[] = []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (i === 0) {
        lines.push(indent + bullet + renderBlock(child).trimStart())
      } else {
        const nested = renderBlock(child, indent + " ".repeat(bullet.length))
        lines.push(nested)
      }
    }
    return lines.join("\n")
  }

  function renderTaskItem(node: TipTapNode, indent: string): string {
    const checked = node.attrs?.checked ? "x" : " "
    const children = node.content ?? []
    const text = children
      .map((child) => renderBlock(child))
      .join("\n")
      .trimStart()
    return `${indent}- [${checked}] ${text}`
  }

  function renderTable(node: TipTapNode): string {
    const rows = node.content ?? []
    if (rows.length === 0) return ""

    const matrix: string[][] = []
    for (const row of rows) {
      const cells = (row.content ?? []).map((cell) => {
        const inner = (cell.content ?? []).map((child) => renderBlock(child)).join(" ")
        return inner.trim()
      })
      matrix.push(cells)
    }

    const colCount = Math.max(...matrix.map((r) => r.length))
    const widths: number[] = Array.from({ length: colCount }, () => 3)
    for (const row of matrix) {
      for (let i = 0; i < row.length; i++) {
        widths[i] = Math.max(widths[i], row[i].length)
      }
    }

    const formatRow = (cells: string[]) => {
      const padded = widths.map((w, i) => (cells[i] ?? "").padEnd(w))
      return `| ${padded.join(" | ")} |`
    }

    const lines: string[] = []
    lines.push(formatRow(matrix[0] ?? []))
    lines.push(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`)
    for (let i = 1; i < matrix.length; i++) {
      lines.push(formatRow(matrix[i]))
    }
    return lines.join("\n")
  }

  function renderChildren(nodes: TipTapNode[]): string {
    return nodes.map((node) => renderBlock(node)).join("\n\n")
  }

  export function toMarkdown(content: any): string {
    if (!content || typeof content !== "object") return ""
    return renderBlock(content as TipTapNode).trim()
  }

  export function fromMarkdown(markdown: string): TipTapNode {
    const lines = markdown.split("\n")
    const blocks = parseBlocks(lines, 0, lines.length)
    return { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] }
  }

  function parseBlocks(lines: string[], start: number, end: number): TipTapNode[] {
    const blocks: TipTapNode[] = []
    let i = start

    while (i < end) {
      const line = lines[i]

      if (line.trim() === "") {
        i++
        continue
      }

      if (/^```/.test(line)) {
        const lang = line.slice(3).trim()
        const codeLines: string[] = []
        i++
        while (i < end && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i])
          i++
        }
        i++
        const node: TipTapNode = { type: "codeBlock", content: [{ type: "text", text: codeLines.join("\n") }] }
        if (lang) node.attrs = { language: lang }
        blocks.push(node)
        continue
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
      if (headingMatch) {
        blocks.push({
          type: "heading",
          attrs: { level: headingMatch[1].length },
          content: parseInline(headingMatch[2]),
        })
        i++
        continue
      }

      if (/^---\s*$/.test(line) || /^\*\*\*\s*$/.test(line) || /^___\s*$/.test(line)) {
        blocks.push({ type: "horizontalRule" })
        i++
        continue
      }

      if (/^\|/.test(line)) {
        const tableResult = parseTable(lines, i, end)
        blocks.push(tableResult.node)
        i = tableResult.nextIndex
        continue
      }

      if (/^>\s?/.test(line)) {
        const quoteLines: string[] = []
        while (i < end && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""))
          i++
        }
        blocks.push({ type: "blockquote", content: parseBlocks(quoteLines, 0, quoteLines.length) })
        continue
      }

      if (/^[-*]\s\[[ x]\]\s/.test(line)) {
        const taskResult = parseTaskList(lines, i, end)
        blocks.push(taskResult.node)
        i = taskResult.nextIndex
        continue
      }

      if (/^[-*]\s/.test(line)) {
        const listResult = parseBulletList(lines, i, end)
        blocks.push(listResult.node)
        i = listResult.nextIndex
        continue
      }

      if (/^\d+\.\s/.test(line)) {
        const listResult = parseOrderedList(lines, i, end)
        blocks.push(listResult.node)
        i = listResult.nextIndex
        continue
      }

      const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/)
      if (imgMatch) {
        blocks.push({ type: "image", attrs: { src: imgMatch[2], alt: imgMatch[1] } })
        i++
        continue
      }

      const paraLines: string[] = [line]
      i++
      while (i < end && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
        paraLines.push(lines[i])
        i++
      }
      blocks.push({ type: "paragraph", content: parseInline(paraLines.join("\n")) })
    }

    return blocks
  }

  function isBlockStart(line: string): boolean {
    if (/^#{1,6}\s/.test(line)) return true
    if (/^```/.test(line)) return true
    if (/^---\s*$/.test(line) || /^\*\*\*\s*$/.test(line) || /^___\s*$/.test(line)) return true
    if (/^>\s?/.test(line)) return true
    if (/^[-*]\s/.test(line)) return true
    if (/^\d+\.\s/.test(line)) return true
    if (/^\|/.test(line)) return true
    if (/^!\[/.test(line)) return true
    return false
  }

  function parseBulletList(lines: string[], start: number, end: number): { node: TipTapNode; nextIndex: number } {
    const items: TipTapNode[] = []
    let i = start

    while (i < end && /^[-*]\s/.test(lines[i])) {
      const text = lines[i].replace(/^[-*]\s/, "")
      const itemContent: string[] = [text]
      i++
      while (i < end && /^\s{2,}/.test(lines[i]) && !/^[-*]\s/.test(lines[i])) {
        itemContent.push(lines[i].trimStart())
        i++
      }
      items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(itemContent.join("\n")) }] })
    }

    return { node: { type: "bulletList", content: items }, nextIndex: i }
  }

  function parseOrderedList(lines: string[], start: number, end: number): { node: TipTapNode; nextIndex: number } {
    const items: TipTapNode[] = []
    let i = start

    while (i < end && /^\d+\.\s/.test(lines[i])) {
      const text = lines[i].replace(/^\d+\.\s/, "")
      const itemContent: string[] = [text]
      i++
      while (i < end && /^\s{2,}/.test(lines[i]) && !/^\d+\.\s/.test(lines[i])) {
        itemContent.push(lines[i].trimStart())
        i++
      }
      items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(itemContent.join("\n")) }] })
    }

    return { node: { type: "orderedList", content: items }, nextIndex: i }
  }

  function parseTaskList(lines: string[], start: number, end: number): { node: TipTapNode; nextIndex: number } {
    const items: TipTapNode[] = []
    let i = start

    while (i < end && /^[-*]\s\[[ x]\]\s/.test(lines[i])) {
      const checked = /^[-*]\s\[x\]\s/i.test(lines[i])
      const text = lines[i].replace(/^[-*]\s\[[ x]\]\s/i, "")
      items.push({
        type: "taskItem",
        attrs: { checked },
        content: [{ type: "paragraph", content: parseInline(text) }],
      })
      i++
    }

    return { node: { type: "taskList", content: items }, nextIndex: i }
  }

  function parseTable(lines: string[], start: number, end: number): { node: TipTapNode; nextIndex: number } {
    const rows: TipTapNode[] = []
    let i = start

    while (i < end && /^\|/.test(lines[i])) {
      const cells = lines[i]
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())

      if (cells.every((c) => /^-+$/.test(c))) {
        i++
        continue
      }

      const isHeader = rows.length === 0
      const cellNodes: TipTapNode[] = cells.map((cell) => ({
        type: isHeader ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph", content: parseInline(cell) }],
      }))
      rows.push({ type: "tableRow", content: cellNodes })
      i++
    }

    return { node: { type: "table", content: rows }, nextIndex: i }
  }

  function parseInline(text: string): TipTapNode[] {
    if (!text) return []
    const nodes: TipTapNode[] = []
    const regex =
      /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]*)\]\(([^)]+)\)|`([^`]+)`|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|(\n)/g
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        nodes.push({ type: "text", text: text.slice(lastIndex, match.index) })
      }

      if (match[1] !== undefined || match[2] !== undefined) {
        nodes.push({ type: "image", attrs: { src: match[2], alt: match[1] ?? "" } })
      } else if (match[3] !== undefined) {
        nodes.push({ type: "text", text: match[3], marks: [{ type: "link", attrs: { href: match[4] } }] })
      } else if (match[5] !== undefined) {
        nodes.push({ type: "text", text: match[5], marks: [{ type: "code" }] })
      } else if (match[6] !== undefined) {
        nodes.push({ type: "text", text: match[6], marks: [{ type: "bold" }, { type: "italic" }] })
      } else if (match[7] !== undefined) {
        nodes.push({ type: "text", text: match[7], marks: [{ type: "bold" }] })
      } else if (match[8] !== undefined) {
        nodes.push({ type: "text", text: match[8], marks: [{ type: "italic" }] })
      } else if (match[9] !== undefined) {
        nodes.push({ type: "text", text: match[9], marks: [{ type: "strike" }] })
      } else if (match[10] !== undefined) {
        nodes.push({ type: "hardBreak" })
      }

      lastIndex = regex.lastIndex
    }

    if (lastIndex < text.length) {
      nodes.push({ type: "text", text: text.slice(lastIndex) })
    }

    return nodes.length > 0 ? nodes : [{ type: "text", text }]
  }
}
