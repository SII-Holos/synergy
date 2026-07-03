import { NoteMarkdown } from "./markdown"

export namespace NoteDocument {
  export type Node = {
    type: string
    attrs?: Record<string, any>
    content?: Node[]
    text?: string
    marks?: Array<{ type: string; attrs?: Record<string, any> }>
  }

  export type BlockInfo = {
    id: string
    type: string
    path: number[]
    pathLabel: string
    depth: number
    hash: string
    text: string
    summary: string
    attrs?: Record<string, any>
    parentId?: string
    tableId?: string
    row?: number
    col?: number
    json?: Node
  }

  export type ContentInput =
    | { format: "text"; text: string }
    | { format: "markdown"; text: string }
    | { format: "json"; json: unknown }

  const INLINE_TYPES = new Set(["text", "hardBreak", "inlineMath", "mathInline", "image"])
  const BLOCK_TYPES = new Set([
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "codeBlock",
    "blockquote",
    "horizontalRule",
    "image",
    "table",
    "tableRow",
    "tableCell",
    "tableHeader",
    "mermaid",
    "mermaidDiagram",
    "video",
  ])
  const KNOWN_TYPES = new Set(["doc", ...INLINE_TYPES, ...BLOCK_TYPES])
  const NON_TARGET_TYPES = new Set(["doc", "text", "hardBreak", "inlineMath", "mathInline"])

  function isObject(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  function clone<T>(value: T): T {
    return structuredClone(value)
  }

  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (!isObject(value)) return JSON.stringify(value)
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    return `{${entries.join(",")}}`
  }

  export function hash(value: unknown): string {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(canonical(value))
    return hasher.digest("hex")
  }

  function createBlockId(existing: Set<string>): string {
    let id = ""
    do {
      id = `blk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    } while (existing.has(id))
    return id
  }

  function isTargetable(node: Node): boolean {
    return !NON_TARGET_TYPES.has(node.type)
  }

  function normalizeNode(node: Node, existing: Set<string>): Node {
    if (!isObject(node) || typeof node.type !== "string") return { type: "paragraph", content: [] }
    const next = clone(node)

    if (next.type === "text") {
      next.text = typeof next.text === "string" ? next.text : ""
      return next
    }

    if (isTargetable(next)) {
      const attrs = isObject(next.attrs) ? { ...next.attrs } : {}
      const current = typeof attrs.blockId === "string" && attrs.blockId.trim() ? attrs.blockId : undefined
      const legacy = typeof attrs.synergyId === "string" && attrs.synergyId.trim() ? attrs.synergyId : undefined
      const id = current ?? legacy
      attrs.blockId = id && !existing.has(id) ? id : createBlockId(existing)
      delete attrs.synergyId
      existing.add(attrs.blockId)
      next.attrs = attrs
    }

    if (Array.isArray(next.content)) {
      next.content = next.content.map((child) => normalizeNode(child, existing))
    }

    return next
  }

  export function normalize(content: unknown): Node {
    const doc = isObject(content) && content.type === "doc" ? clone(content as Node) : { type: "doc", content: [] }
    doc.content = Array.isArray(doc.content) ? doc.content : []
    const existing = new Set<string>()
    return { ...doc, content: doc.content.map((child) => normalizeNode(child, existing)) }
  }

  function blockId(node: Node): string | undefined {
    if (typeof node.attrs?.blockId === "string") return node.attrs.blockId
    return typeof node.attrs?.synergyId === "string" ? node.attrs.synergyId : undefined
  }

  function childTextSeparator(node: Node): string {
    switch (node.type) {
      case "paragraph":
      case "heading":
      case "codeBlock":
        return ""
      case "tableRow":
        return " | "
      default:
        return "\n"
    }
  }

  function nodeText(node: Node): string {
    switch (node.type) {
      case "text":
        return node.text ?? ""
      case "hardBreak":
        return "\n"
      case "inlineMath":
      case "mathInline":
        return node.attrs?.latex ?? ""
      case "image":
        return node.attrs?.alt ?? node.attrs?.src ?? ""
      case "video":
        return node.attrs?.src ?? ""
      case "mermaid":
      case "mermaidDiagram":
        return node.attrs?.content ?? ""
      default:
        return (node.content ?? []).map(nodeText).join(childTextSeparator(node))
    }
  }

  function attrsForDisplay(node: Node): Record<string, any> | undefined {
    const attrs = { ...(node.attrs ?? {}) }
    delete attrs.blockId
    delete attrs.synergyId
    return Object.keys(attrs).length ? attrs : undefined
  }

  function summarize(node: Node, text: string, row?: number, col?: number): string {
    const compact = text.replace(/\s+/g, " ").trim()
    switch (node.type) {
      case "heading":
        return `${"#".repeat(node.attrs?.level ?? 1)} ${compact}`.trim()
      case "paragraph":
        return compact || "(empty paragraph)"
      case "bulletList":
      case "orderedList":
        return `${node.type} (${node.content?.length ?? 0} items)`
      case "taskList":
        return `taskList (${node.content?.length ?? 0} items)`
      case "listItem":
      case "taskItem":
        return compact || node.type
      case "codeBlock":
        return `codeBlock${node.attrs?.language ? `:${node.attrs.language}` : ""} (${text.split("\n").length} lines)`
      case "blockquote":
        return compact || "blockquote"
      case "horizontalRule":
        return "---"
      case "image":
        return `image ${node.attrs?.alt ?? node.attrs?.src ?? ""}`.trim()
      case "video":
        return `video ${node.attrs?.src ?? ""}`.trim()
      case "mermaid":
      case "mermaidDiagram":
        return `mermaid ${compact.split("\n")[0] ?? ""}`.trim()
      case "table":
        return `table (${node.content?.length ?? 0} rows)`
      case "tableRow":
        return `table row ${row ?? ""}`.trim()
      case "tableCell":
      case "tableHeader":
        return `cell ${row ?? "?"},${col ?? "?"}: ${compact}`.trim()
      default:
        return compact || node.type
    }
  }

  function pathLabel(path: number[]): string {
    return path.length ? path.join(".") : "root"
  }

  export function listBlocks(content: unknown, options?: { includeJson?: boolean }): BlockInfo[] {
    const doc = normalize(content)
    const blocks: BlockInfo[] = []

    function visit(
      node: Node,
      path: number[],
      context: { parentId?: string; tableId?: string; row?: number; col?: number },
    ) {
      const id = blockId(node)
      let nextContext = context
      if (id && isTargetable(node)) {
        const text = nodeText(node)
        const entry: BlockInfo = {
          id,
          type: node.type,
          path,
          pathLabel: pathLabel(path),
          depth: path.length,
          hash: hash(node),
          text,
          summary: summarize(node, text, context.row, context.col),
          attrs: attrsForDisplay(node),
          parentId: context.parentId,
          tableId: context.tableId,
          row: context.row,
          col: context.col,
          ...(options?.includeJson ? { json: node } : {}),
        }
        blocks.push(entry)

        if (node.type === "table") {
          nextContext = { ...context, parentId: id, tableId: id }
        } else {
          nextContext = { ...context, parentId: id }
        }
      }

      const children = node.content ?? []
      children.forEach((child, index) => {
        const childContext = { ...nextContext }
        if (node.type === "table") childContext.row = index
        if (node.type === "tableRow") childContext.col = index
        visit(child, [...path, index], childContext)
      })
    }

    doc.content?.forEach((node, index) => visit(node, [index], {}))
    return blocks
  }

  export function validate(content: unknown): { ok: true; doc: Node } | { ok: false; errors: string[] } {
    const doc = normalize(content)
    const errors: string[] = []
    const seen = new Set<string>()

    function assertContent(node: Node, expected: (child: Node) => boolean, label: string, path: number[]) {
      for (const [index, child] of (node.content ?? []).entries()) {
        if (!expected(child))
          errors.push(`${pathLabel([...path, index])}: ${node.type} cannot contain ${child.type}; expected ${label}`)
      }
    }

    function isBlock(child: Node) {
      return BLOCK_TYPES.has(child.type)
    }

    function isInline(child: Node) {
      return INLINE_TYPES.has(child.type)
    }

    function visit(node: Node, path: number[]) {
      if (!KNOWN_TYPES.has(node.type)) errors.push(`${pathLabel(path)}: unknown node type "${node.type}"`)
      if (node.type === "text" && typeof node.text !== "string")
        errors.push(`${pathLabel(path)}: text node missing text`)
      if (node.content !== undefined && !Array.isArray(node.content))
        errors.push(`${pathLabel(path)}: content must be an array`)

      const id = blockId(node)
      if (isTargetable(node)) {
        if (!id) errors.push(`${pathLabel(path)}: ${node.type} missing attrs.blockId`)
        else if (seen.has(id)) errors.push(`${pathLabel(path)}: duplicate attrs.blockId "${id}"`)
        else seen.add(id)
      }

      switch (node.type) {
        case "doc":
          assertContent(node, isBlock, "block nodes", path)
          break
        case "paragraph":
        case "heading":
          assertContent(node, isInline, "inline nodes", path)
          break
        case "codeBlock":
          assertContent(node, (child) => child.type === "text", "text nodes", path)
          break
        case "bulletList":
        case "orderedList":
          assertContent(node, (child) => child.type === "listItem", "listItem nodes", path)
          break
        case "taskList":
          assertContent(node, (child) => child.type === "taskItem", "taskItem nodes", path)
          break
        case "listItem":
        case "taskItem":
        case "blockquote":
        case "tableCell":
        case "tableHeader":
          assertContent(node, isBlock, "block nodes", path)
          break
        case "table":
          assertContent(node, (child) => child.type === "tableRow", "tableRow nodes", path)
          break
        case "tableRow":
          assertContent(
            node,
            (child) => child.type === "tableCell" || child.type === "tableHeader",
            "table cell nodes",
            path,
          )
          break
      }

      node.content?.forEach((child, index) => visit(child, [...path, index]))
    }

    visit(doc, [])
    return errors.length ? { ok: false, errors } : { ok: true, doc }
  }

  export function parseContent(input: ContentInput): Node[] {
    if (input.format === "text") {
      return (
        normalize({
          type: "doc",
          content: [{ type: "paragraph", content: input.text ? [{ type: "text", text: input.text }] : [] }],
        }).content ?? []
      )
    }

    if (input.format === "markdown") {
      return normalize(NoteMarkdown.fromMarkdown(input.text)).content ?? []
    }

    if (!isObject(input.json)) throw new Error("JSON content must be a ProseMirror node or doc object.")
    const node = input.json as Node
    const doc = node.type === "doc" ? normalize(node) : normalize({ type: "doc", content: [node] })
    const validation = validate(doc)
    if (!validation.ok) throw new Error(`Invalid JSON content: ${validation.errors.join("; ")}`)
    return validation.doc.content ?? []
  }

  function parentContent(doc: Node, path: number[]): { content: Node[]; index: number } {
    if (path.length === 0) throw new Error("Cannot edit the document root.")
    let current = doc
    for (const index of path.slice(0, -1)) {
      current = current.content?.[index] as Node
      if (!current || !Array.isArray(current.content)) throw new Error(`Invalid path ${pathLabel(path)}.`)
    }
    const content = current.content
    if (!Array.isArray(content)) throw new Error(`Invalid parent path ${pathLabel(path.slice(0, -1))}.`)
    return { content, index: path[path.length - 1] }
  }

  export function replaceBlock(doc: Node, block: BlockInfo, nodes: Node[]): Node {
    const next = normalize(doc)
    const target = parentContent(next, block.path)
    target.content.splice(target.index, 1, ...nodes)
    return normalize(next)
  }

  export function insertNearBlock(doc: Node, block: BlockInfo, nodes: Node[], side: "before" | "after"): Node {
    const next = normalize(doc)
    const target = parentContent(next, block.path)
    target.content.splice(target.index + (side === "after" ? 1 : 0), 0, ...nodes)
    return normalize(next)
  }

  export function deleteBlock(doc: Node, block: BlockInfo): Node {
    const next = normalize(doc)
    const target = parentContent(next, block.path)
    target.content.splice(target.index, 1)
    return normalize(next)
  }

  export function setAttrs(doc: Node, block: BlockInfo, attrs: Record<string, any>): Node {
    const next = normalize(doc)
    const target = parentContent(next, block.path)
    const node = target.content[target.index]
    const id = blockId(node)
    const { blockId: _blockId, synergyId: _synergyId, ...nextAttrs } = attrs
    target.content[target.index] = {
      ...node,
      attrs: {
        ...(node.attrs ?? {}),
        ...nextAttrs,
        ...(id ? { blockId: id } : {}),
      },
    }
    return normalize(next)
  }

  type TextRef = { node: Node; start: number; end: number }

  function textRefs(node: Node): TextRef[] {
    const refs: TextRef[] = []
    let offset = 0

    function visit(current: Node) {
      if (current.type === "text") {
        const text = current.text ?? ""
        refs.push({ node: current, start: offset, end: offset + text.length })
        offset += text.length
        return
      }
      if (
        current.type === "hardBreak" ||
        current.type === "inlineMath" ||
        current.type === "mathInline" ||
        current.type === "image" ||
        current.type === "video" ||
        current.type === "mermaid" ||
        current.type === "mermaidDiagram"
      ) {
        offset += nodeText(current).length
        return
      }

      const children = current.content ?? []
      const separator = childTextSeparator(current)
      children.forEach((child, index) => {
        if (index > 0) offset += separator.length
        visit(child)
      })
    }

    visit(node)
    return refs
  }

  function editableLength(refs: TextRef[], from: number, to: number): number {
    return refs.reduce((sum, ref) => sum + Math.max(0, Math.min(to, ref.end) - Math.max(from, ref.start)), 0)
  }

  function pruneEmptyText(node: Node): Node {
    if (!node.content) return node
    node.content = node.content
      .map(pruneEmptyText)
      .filter((child) => child.type !== "text" || (child.text ?? "").length > 0)
    return node
  }

  export function replaceText(
    doc: Node,
    block: BlockInfo,
    input: { find?: string; range?: { from: number; to: number }; replacement: string; occurrence?: number },
  ): Node {
    const next = normalize(doc)
    const target = parentContent(next, block.path)
    const node = target.content[target.index]
    const text = nodeText(node)
    let from: number
    let to: number

    if (input.range) {
      from = input.range.from
      to = input.range.to
    } else if (input.find !== undefined) {
      const matches: number[] = []
      let at = text.indexOf(input.find)
      while (at >= 0) {
        matches.push(at)
        at = text.indexOf(input.find, at + input.find.length)
      }
      if (matches.length === 0) throw new Error(`Text "${input.find}" was not found in block ${block.id}.`)
      if (matches.length > 1 && input.occurrence === undefined) {
        throw new Error(`Text "${input.find}" occurs ${matches.length} times in block ${block.id}; specify occurrence.`)
      }
      const occurrence = input.occurrence ?? 1
      const start = matches[occurrence - 1]
      if (start === undefined) throw new Error(`Occurrence ${occurrence} was not found in block ${block.id}.`)
      from = start
      to = start + input.find.length
    } else {
      throw new Error("replaceText requires find or range.")
    }

    if (from < 0 || to < from || to > text.length) throw new Error(`Invalid text range ${from}-${to}.`)
    const allRefs = textRefs(node)
    const refs = allRefs.filter((ref) => ref.end > from && ref.start < to)
    if (from === to) {
      const insertionRef = allRefs.find((ref) => ref.start <= from && from <= ref.end)
      if (!insertionRef) {
        if (text.length === 0) {
          node.content = [...(node.content ?? []), { type: "text", text: input.replacement }]
          return normalize(next)
        }
        throw new Error("Text insertion point does not overlap editable text nodes.")
      }

      const current = insertionRef.node.text ?? ""
      const local = from - insertionRef.start
      insertionRef.node.text = current.slice(0, local) + input.replacement + current.slice(local)
      target.content[target.index] = pruneEmptyText(node)
      return normalize(next)
    }

    if (refs.length === 0) throw new Error("Text range does not overlap editable text nodes.")
    if (editableLength(refs, from, to) !== to - from) {
      throw new Error("Text range includes non-editable content; replace a narrower text span or replace the block.")
    }

    const first = refs[0]
    const last = refs[refs.length - 1]
    const firstText = first.node.text ?? ""
    const lastText = last.node.text ?? ""
    const prefix = firstText.slice(0, Math.max(0, from - first.start))
    const suffix = lastText.slice(Math.max(0, to - last.start))
    first.node.text = prefix + input.replacement + (first === last ? suffix : "")
    for (const ref of refs.slice(1, -1)) ref.node.text = ""
    if (last !== first) last.node.text = suffix
    target.content[target.index] = pruneEmptyText(node)
    return normalize(next)
  }

  export function updateTableCell(
    doc: Node,
    input: { tableId?: string; cellId?: string; row?: number; col?: number; content: Node[] },
  ): { doc: Node; cell: BlockInfo } {
    const current = normalize(doc)
    let cell: BlockInfo | undefined
    if (input.cellId) {
      cell = listBlocks(current, { includeJson: true }).find((block) => block.id === input.cellId)
    } else if (input.tableId !== undefined && input.row !== undefined && input.col !== undefined) {
      cell = listBlocks(current, { includeJson: true }).find(
        (block) =>
          (block.type === "tableCell" || block.type === "tableHeader") &&
          block.tableId === input.tableId &&
          block.row === input.row &&
          block.col === input.col,
      )
    }
    if (!cell || (cell.type !== "tableCell" && cell.type !== "tableHeader")) {
      throw new Error("Target table cell was not found.")
    }

    const next = normalize(current)
    const target = parentContent(next, cell.path)
    target.content[target.index] = { ...target.content[target.index], content: input.content }
    return { doc: normalize(next), cell }
  }

  export function replaceRange(doc: Node, start: BlockInfo, end: BlockInfo, nodes: Node[]): Node {
    const next = normalize(doc)
    const startParent = parentContent(next, start.path)
    const endParent = parentContent(next, end.path)
    const sameParent =
      start.path.length === end.path.length &&
      start.path.slice(0, -1).every((value, index) => value === end.path[index])
    if (!sameParent || startParent.content !== endParent.content) {
      throw new Error("replaceRange currently requires start and end blocks to share the same parent.")
    }
    const from = Math.min(startParent.index, endParent.index)
    const to = Math.max(startParent.index, endParent.index)
    startParent.content.splice(from, to - from + 1, ...nodes)
    return normalize(next)
  }
}
