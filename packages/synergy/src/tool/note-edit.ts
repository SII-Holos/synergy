import z from "zod"
import { Tool } from "./tool"
import { NoteBlueprintPolicy, NoteDocument, NoteError, NoteStore } from "../note"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import DESCRIPTION from "./note-edit.txt"
import { Session } from "../session"

const contentInput = z.discriminatedUnion("format", [
  z.object({ format: z.literal("text"), text: z.string() }),
  z.object({ format: z.literal("markdown"), text: z.string() }),
  z.object({ format: z.literal("json"), json: z.any() }),
])

const replaceBlockOp = z.object({
  action: z.literal("replaceBlock"),
  blockId: z.string(),
  expectedHash: z.string(),
  content: contentInput,
})

const insertBeforeOp = z.object({
  action: z.literal("insertBefore"),
  blockId: z.string(),
  content: contentInput,
})

const insertAfterOp = z.object({
  action: z.literal("insertAfter"),
  blockId: z.string(),
  content: contentInput,
})

const deleteBlockOp = z.object({
  action: z.literal("deleteBlock"),
  blockId: z.string(),
  expectedHash: z.string(),
})

const setAttrsOp = z.object({
  action: z.literal("setAttrs"),
  blockId: z.string(),
  expectedHash: z.string(),
  attrs: z.record(z.string(), z.any()),
})

const replaceTextOp = z.object({
  action: z.literal("replaceText"),
  blockId: z.string(),
  expectedHash: z.string(),
  find: z.string().optional(),
  range: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
  replacement: z.string(),
  occurrence: z.number().int().min(1).optional(),
})

const updateTableCellOp = z.object({
  action: z.literal("updateTableCell"),
  tableId: z.string().optional(),
  cellId: z.string().optional(),
  row: z.number().int().min(0).optional(),
  col: z.number().int().min(0).optional(),
  expectedHash: z.string().optional(),
  content: contentInput,
})

const replaceRangeOp = z.object({
  action: z.literal("replaceRange"),
  startBlockId: z.string(),
  endBlockId: z.string(),
  expectedStartHash: z.string(),
  expectedEndHash: z.string(),
  content: contentInput,
})

const operation = z.union([
  replaceBlockOp,
  insertBeforeOp,
  insertAfterOp,
  deleteBlockOp,
  setAttrsOp,
  replaceTextOp,
  updateTableCellOp,
  replaceRangeOp,
])

const parameters = z.object({
  id: z.string().describe("The note ID to edit."),
  baseVersion: z.number().int().min(1).describe("Note version returned by note_read(format:'blocks'|'json')."),
  baseDocHash: z.string().optional().describe("DocHash returned by note_read. If provided, mismatches fail safely."),
  dryRun: z.boolean().default(false).describe("Preview the edit without writing the note."),
  ops: z.array(operation).min(1).describe("Ordered list of anchored note edit operations."),
})

type Params = z.infer<typeof parameters>
type Operation = z.infer<typeof operation>

type BlockPreview = {
  id: string
  type: string
  path: string
  hash?: string
  text?: string
  summary: string
  row?: number
  col?: number
  tableId?: string
}

type OperationSemanticResult = {
  opIndex: number
  action: Operation["action"]
  status: "applied" | "noop"
  targetBlocks: BlockPreview[]
  directChangedBlocks: BlockPreview[]
  ancestorChangedBlocks: BlockPreview[]
  unexpectedChangedBlocks: BlockPreview[]
  semantic: Record<string, unknown>
  checks: Record<string, boolean | number | string | undefined>
  warnings: string[]
}

type SemanticSeed = {
  targetIds: string[]
  directIds: string[]
  semantic: Record<string, unknown>
  checks?: Record<string, boolean | number | string | undefined>
}

type ApplyResult = { doc: NoteDocument.Node; touched: string[]; semanticSeed: SemanticSeed }

const BLOCK_PREVIEW_LIMIT = 800
const CONTEXT_RADIUS = 120

function previewText(text: string, limit = BLOCK_PREVIEW_LIMIT) {
  if (text.length <= limit) return text
  const head = Math.floor((limit - 32) / 2)
  const tail = Math.max(0, limit - 32 - head)
  return `${text.slice(0, head)}…[${text.length} chars]…${text.slice(text.length - tail)}`
}

function contextText(text: string, from: number, to: number) {
  const start = Math.max(0, from - CONTEXT_RADIUS)
  const end = Math.min(text.length, to + CONTEXT_RADIUS)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return `${prefix}${text.slice(start, end)}${suffix}`
}

function countOccurrences(text: string, find: string) {
  if (!find) return 0
  let count = 0
  let at = text.indexOf(find)
  while (at >= 0) {
    count++
    at = text.indexOf(find, at + find.length)
  }
  return count
}

function blockPreview(block: NoteDocument.BlockInfo | undefined): BlockPreview | undefined {
  if (!block) return undefined
  return {
    id: block.id,
    type: block.type,
    path: block.pathLabel,
    hash: block.hash,
    text: previewText(block.text),
    summary: block.summary,
    row: block.row,
    col: block.col,
    tableId: block.tableId,
  }
}

function compactBlocks(content: unknown, ids?: string[]) {
  const blocks = NoteDocument.listBlocks(content)
  const filtered = ids?.length ? blocks.filter((block) => ids.includes(block.id)) : blocks.slice(0, 20)
  return filtered.map((block) => ({
    id: block.id,
    type: block.type,
    path: block.pathLabel,
    hash: block.hash,
    summary: block.summary,
    row: block.row,
    col: block.col,
    tableId: block.tableId,
  }))
}

function errorResult(input: {
  id: string
  code: string
  message: string
  note?: Awaited<ReturnType<typeof NoteStore.getAny>>
  blockIds?: string[]
  failedOpIndex?: number
  failedAction?: Operation["action"]
}) {
  const doc = input.note ? NoteDocument.normalize(input.note.content) : undefined
  const docHash = doc ? NoteDocument.hash(doc) : undefined
  return {
    title: "Error",
    output: [
      `Error: ${input.message}`,
      `Code: ${input.code}`,
      `ID: ${input.id}`,
      input.failedOpIndex !== undefined
        ? `Failed operation: ${input.failedOpIndex + 1} ${input.failedAction}`
        : undefined,
      input.failedOpIndex !== undefined ? "No write occurred." : undefined,
      ...(input.note ? [`Current version: ${input.note.version}`] : []),
      ...(docHash ? [`Current docHash: ${docHash}`] : []),
      ...(doc ? ["Current blocks:", JSON.stringify(compactBlocks(doc, input.blockIds), null, 2)] : []),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
    metadata: {
      id: input.id,
      errorCode: input.code,
      currentVersion: input.note?.version,
      currentDocHash: docHash,
      blocks: doc ? compactBlocks(doc, input.blockIds) : undefined,
      failedOpIndex: input.failedOpIndex,
      failedAction: input.failedAction,
    } as Record<string, any>,
  }
}

function blockMap(doc: NoteDocument.Node) {
  return new Map(NoteDocument.listBlocks(doc, { includeJson: true }).map((block) => [block.id, block]))
}

function blocksMap(blocks: NoteDocument.BlockInfo[]) {
  return new Map(blocks.map((block) => [block.id, block]))
}

function requireHash(block: NoteDocument.BlockInfo, expectedHash: string | undefined, context: string) {
  if (!expectedHash) throw new Error(`${context} requires expectedHash from note_read(format:"blocks").`)
  if (block.hash !== expectedHash) {
    throw new Error(`${context} hash mismatch for block ${block.id}. Expected ${expectedHash}, current ${block.hash}.`)
  }
}

function resolveById(doc: NoteDocument.Node, blockId: string, expectedHash: string | undefined, context: string) {
  const block = blockMap(doc).get(blockId)
  if (!block) throw new Error(`${context} target block ${blockId} was not found.`)
  if (expectedHash) requireHash(block, expectedHash, context)
  return block
}

function resolveTableCell(doc: NoteDocument.Node, op: z.infer<typeof updateTableCellOp>) {
  const cell = NoteDocument.listBlocks(doc, { includeJson: true }).find((block) => {
    if (block.type !== "tableCell" && block.type !== "tableHeader") return false
    if (op.cellId) return block.id === op.cellId
    return block.tableId === op.tableId && block.row === op.row && block.col === op.col
  })
  if (!cell) throw new Error("Target table cell was not found.")
  return cell
}

function targetIds(op: Operation): string[] {
  switch (op.action) {
    case "replaceBlock":
    case "insertBefore":
    case "deleteBlock":
    case "setAttrs":
    case "replaceText":
      return [op.blockId]
    case "insertAfter":
      return [op.blockId]
    case "updateTableCell":
      return [op.cellId, op.tableId].filter((value): value is string => !!value)
    case "replaceRange":
      return [op.startBlockId, op.endBlockId]
  }
}

function contentText(nodes: NoteDocument.Node[]) {
  const doc = NoteDocument.normalize({ type: "doc", content: nodes })
  return NoteDocument.listBlocks(doc)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
}

function isSameParentPath(a: number[], b: number[]) {
  return a.length === b.length && a.slice(0, -1).every((value, index) => value === b[index])
}

function isPathPrefix(parent: number[], child: number[]) {
  return parent.every((value, index) => child[index] === value)
}

function rangeBlocks(doc: NoteDocument.Node, start: NoteDocument.BlockInfo, end: NoteDocument.BlockInfo) {
  const from = Math.min(start.path[start.path.length - 1], end.path[end.path.length - 1])
  const to = Math.max(start.path[start.path.length - 1], end.path[end.path.length - 1])
  const parent = start.path.slice(0, -1)
  return NoteDocument.listBlocks(doc).filter((block) => {
    if (block.path.length < start.path.length) return false
    if (!isPathPrefix(parent, block.path)) return false
    const siblingIndex = block.path[parent.length]
    return siblingIndex >= from && siblingIndex <= to
  })
}

function applyOperation(doc: NoteDocument.Node, op: Operation): ApplyResult {
  switch (op.action) {
    case "replaceBlock": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "replaceBlock")
      const nodes = NoteDocument.parseContent(op.content)
      return {
        doc: NoteDocument.replaceBlock(doc, block, nodes),
        touched: [block.id],
        semanticSeed: {
          targetIds: [block.id],
          directIds: [block.id],
          semantic: {
            removedBlocks: [blockPreview(block)].filter(Boolean),
            replacementText: previewText(contentText(nodes)),
          },
        },
      }
    }
    case "insertBefore": {
      const block = resolveById(doc, op.blockId, undefined, "insertBefore")
      const nodes = NoteDocument.parseContent(op.content)
      return {
        doc: NoteDocument.insertNearBlock(doc, block, nodes, "before"),
        touched: [block.id],
        semanticSeed: {
          targetIds: [block.id],
          directIds: [block.id],
          semantic: {
            side: "before",
            anchorText: previewText(block.text),
            insertedText: previewText(contentText(nodes)),
          },
        },
      }
    }
    case "insertAfter": {
      const block = resolveById(doc, op.blockId, undefined, "insertAfter")
      const nodes = NoteDocument.parseContent(op.content)
      return {
        doc: NoteDocument.insertNearBlock(doc, block, nodes, "after"),
        touched: [block.id],
        semanticSeed: {
          targetIds: [block.id],
          directIds: [block.id],
          semantic: {
            side: "after",
            anchorText: previewText(block.text),
            insertedText: previewText(contentText(nodes)),
          },
        },
      }
    }
    case "deleteBlock": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "deleteBlock")
      return {
        doc: NoteDocument.deleteBlock(doc, block),
        touched: [block.id],
        semanticSeed: {
          targetIds: [block.id],
          directIds: [block.id],
          semantic: { deletedBlocks: [blockPreview(block)].filter(Boolean), deletedText: previewText(block.text) },
        },
      }
    }
    case "setAttrs": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "setAttrs")
      return {
        doc: NoteDocument.setAttrs(doc, block, op.attrs),
        touched: [block.id],
        semanticSeed: {
          targetIds: [block.id],
          directIds: [block.id],
          semantic: { beforeAttrs: block.attrs ?? {}, afterAttrs: op.attrs },
        },
      }
    }
    case "replaceText": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "replaceText")
      const result = NoteDocument.replaceTextDetailed(doc, block, {
        find: op.find,
        range: op.range,
        replacement: op.replacement,
        occurrence: op.occurrence,
      })
      const checks = {
        matchedRequestedText: op.find === undefined || result.matchedText === op.find,
        replacementPresentInTarget: result.afterText.includes(op.replacement),
        oldTextRemainingInTargetCount: op.find === undefined ? undefined : countOccurrences(result.afterText, op.find),
      }
      return {
        doc: result.doc,
        touched: [block.id],
        semanticSeed: {
          targetIds: [block.id],
          directIds: [block.id],
          semantic: {
            find: op.find,
            range: { from: result.from, to: result.to },
            occurrence: op.occurrence ?? 1,
            matchedText: result.matchedText,
            replacement: op.replacement,
            beforeContext: contextText(result.beforeText, result.from, result.to),
            afterContext: contextText(result.afterText, result.from, result.from + op.replacement.length),
            beforeText: previewText(result.beforeText),
            afterText: previewText(result.afterText),
          },
          checks,
        },
      }
    }
    case "updateTableCell": {
      const current = resolveTableCell(doc, op)
      if (op.expectedHash) {
        requireHash(current, op.expectedHash, "updateTableCell")
      }
      const nodes = NoteDocument.parseContent(op.content)
      const result = NoteDocument.updateTableCell(doc, {
        tableId: op.tableId,
        cellId: op.cellId,
        row: op.row,
        col: op.col,
        content: nodes,
      })
      const requestedText = contentText(nodes)
      return {
        doc: result.doc,
        touched: [result.cell.id],
        semanticSeed: {
          targetIds: [result.cell.id, result.cell.tableId].filter((id): id is string => !!id),
          directIds: [result.cell.id],
          semantic: {
            cellId: result.cell.id,
            tableId: result.cell.tableId,
            row: result.cell.row,
            col: result.cell.col,
            beforeText: previewText(result.cell.text),
            replacementText: previewText(requestedText),
          },
          checks: { replacementPresentInTarget: requestedText.length ? undefined : true },
        },
      }
    }
    case "replaceRange": {
      const start = resolveById(doc, op.startBlockId, op.expectedStartHash, "replaceRange start")
      const end = resolveById(doc, op.endBlockId, op.expectedEndHash, "replaceRange end")
      if (!isSameParentPath(start.path, end.path)) {
        throw new Error("replaceRange currently requires start and end blocks to share the same parent.")
      }
      const removedBlocks = rangeBlocks(doc, start, end)
      const nodes = NoteDocument.parseContent(op.content)
      return {
        doc: NoteDocument.replaceRange(doc, start, end, nodes),
        touched: [start.id, end.id],
        semanticSeed: {
          targetIds: [start.id, end.id],
          directIds: removedBlocks.map((block) => block.id),
          semantic: {
            removedBlocks: removedBlocks.map(blockPreview).filter((block): block is BlockPreview => !!block),
            replacementText: previewText(contentText(nodes)),
          },
        },
      }
    }
  }
}

function changedBlocks(before: NoteDocument.Node, after: NoteDocument.Node, touched: Set<string>) {
  const beforeHashes = new Map(NoteDocument.listBlocks(before).map((block) => [block.id, block.hash]))
  return NoteDocument.listBlocks(after).filter(
    (block) => touched.has(block.id) || beforeHashes.get(block.id) !== block.hash,
  )
}

function changedIds(beforeBlocks: NoteDocument.BlockInfo[], afterBlocks: NoteDocument.BlockInfo[]) {
  const before = blocksMap(beforeBlocks)
  const after = blocksMap(afterBlocks)
  const ids = new Set([...before.keys(), ...after.keys()])
  return [...ids].filter((id) => before.get(id)?.hash !== after.get(id)?.hash)
}

function ancestorIds(
  beforeBlocks: NoteDocument.BlockInfo[],
  afterBlocks: NoteDocument.BlockInfo[],
  directIds: Set<string>,
  changed: Set<string>,
) {
  const before = blocksMap(beforeBlocks)
  const after = blocksMap(afterBlocks)
  const ancestors = new Set<string>()
  for (const id of directIds) {
    let current = after.get(id) ?? before.get(id)
    while (current?.parentId) {
      if (changed.has(current.parentId)) ancestors.add(current.parentId)
      current = after.get(current.parentId) ?? before.get(current.parentId)
    }
  }
  return ancestors
}

function previewForId(
  id: string,
  before: Map<string, NoteDocument.BlockInfo>,
  after: Map<string, NoteDocument.BlockInfo>,
) {
  return blockPreview(after.get(id) ?? before.get(id))
}

function classifyChanges(
  beforeBlocks: NoteDocument.BlockInfo[],
  afterBlocks: NoteDocument.BlockInfo[],
  directIds: string[],
) {
  const before = blocksMap(beforeBlocks)
  const after = blocksMap(afterBlocks)
  const changed = new Set(changedIds(beforeBlocks, afterBlocks))
  const insertedIds = [...after.keys()].filter((id) => !before.has(id))
  const allDirect = new Set(
    [...directIds, ...insertedIds].filter((id) => changed.has(id) || !before.has(id) || !after.has(id)),
  )
  const ancestors = ancestorIds(beforeBlocks, afterBlocks, allDirect, changed)
  const unexpected = [...changed].filter((id) => !allDirect.has(id) && !ancestors.has(id))
  return {
    directChangedBlocks: [...allDirect]
      .map((id) => previewForId(id, before, after))
      .filter((block): block is BlockPreview => !!block),
    ancestorChangedBlocks: [...ancestors]
      .map((id) => previewForId(id, before, after))
      .filter((block): block is BlockPreview => !!block),
    unexpectedChangedBlocks: unexpected
      .map((id) => previewForId(id, before, after))
      .filter((block): block is BlockPreview => !!block),
  }
}

function buildOperationResult(input: {
  opIndex: number
  action: Operation["action"]
  beforeDoc: NoteDocument.Node
  afterDoc: NoteDocument.Node
  beforeBlocks: NoteDocument.BlockInfo[]
  afterBlocks: NoteDocument.BlockInfo[]
  seed: SemanticSeed
}): OperationSemanticResult {
  const beforeHash = NoteDocument.hash(input.beforeDoc)
  const afterHash = NoteDocument.hash(input.afterDoc)
  const before = blocksMap(input.beforeBlocks)
  const after = blocksMap(input.afterBlocks)
  const classified = classifyChanges(input.beforeBlocks, input.afterBlocks, input.seed.directIds)
  const noop = beforeHash === afterHash
  const targetBlocks = input.seed.targetIds
    .map((id) => previewForId(id, before, after))
    .filter((block): block is BlockPreview => !!block)
  const checks: Record<string, boolean | number | string | undefined> = { ...input.seed.checks, noop }
  if (input.action === "updateTableCell" && checks.replacementPresentInTarget === undefined) {
    const direct = classified.directChangedBlocks[0]
    const replacement = input.seed.semantic.replacementText
    checks.replacementPresentInTarget =
      typeof replacement === "string" && replacement.length > 0 ? (direct?.text ?? "").includes(replacement) : true
  }
  const warnings: string[] = []
  if (noop) warnings.push("Operation produced no document change.")
  if (classified.unexpectedChangedBlocks.length > 0)
    warnings.push("Operation changed blocks outside direct targets and ancestors.")
  if (input.action === "replaceText" && checks.replacementPresentInTarget === false) {
    warnings.push("Replacement text is not present in the target block after editing.")
  }
  return {
    opIndex: input.opIndex,
    action: input.action,
    status: noop ? "noop" : "applied",
    targetBlocks,
    ...classified,
    semantic: input.seed.semantic,
    checks,
    warnings,
  }
}

function renderBlockTarget(block: BlockPreview) {
  const rowCol = block.row !== undefined && block.col !== undefined ? ` row=${block.row} col=${block.col}` : ""
  const table = block.tableId ? ` table=${block.tableId}` : ""
  return `${block.type} path=${block.path} id=${block.id}${rowCol}${table} hash=${block.hash}`
}

function renderChecks(checks: OperationSemanticResult["checks"]) {
  return Object.entries(checks)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
}

function renderOperationResult(result: OperationSemanticResult) {
  const semantic = result.semantic
  const lines = [`Operation ${result.opIndex + 1} ${result.action}: ${result.status}`]
  for (const target of result.targetBlocks) lines.push(`Target: ${renderBlockTarget(target)}`)
  if (typeof semantic.matchedText === "string") {
    const range = semantic.range as { from?: number; to?: number } | undefined
    lines.push(
      `Matched: ${JSON.stringify(semantic.matchedText)} at ${range?.from ?? "?"}-${range?.to ?? "?"} occurrence=${semantic.occurrence ?? 1}`,
    )
  }
  if (typeof semantic.beforeContext === "string") lines.push(`Before context: ${semantic.beforeContext}`)
  if (typeof semantic.afterContext === "string") lines.push(`After context: ${semantic.afterContext}`)
  if (typeof semantic.beforeText === "string") lines.push(`Before: ${semantic.beforeText}`)
  if (typeof semantic.afterText === "string") lines.push(`After: ${semantic.afterText}`)
  if (typeof semantic.deletedText === "string") lines.push(`Deleted: ${semantic.deletedText}`)
  if (typeof semantic.insertedText === "string") lines.push(`Inserted: ${semantic.insertedText}`)
  if (typeof semantic.replacementText === "string") lines.push(`Replacement: ${semantic.replacementText}`)
  if (semantic.beforeAttrs || semantic.afterAttrs) {
    lines.push(`Attrs: ${JSON.stringify(semantic.beforeAttrs ?? {})} -> ${JSON.stringify(semantic.afterAttrs ?? {})}`)
  }
  lines.push(`Checks: ${renderChecks(result.checks)}`)
  lines.push(
    `Changed: direct=${result.directChangedBlocks.length} ancestor=${result.ancestorChangedBlocks.length} unexpected=${result.unexpectedChangedBlocks.length}`,
  )
  if (result.warnings.length) lines.push(`Warnings: ${result.warnings.join("; ")}`)
  return lines.join("\n")
}

export const NoteEditTool = Tool.define("note_edit", {
  description: DESCRIPTION,
  parameters,
  async execute(params: Params, ctx) {
    let existing: Awaited<ReturnType<typeof NoteStore.getAny>>
    try {
      existing = await NoteStore.getAny(ScopeContext.current.scope.id, params.id)
    } catch (error) {
      if (error instanceof Storage.NotFoundError) {
        return errorResult({
          id: params.id,
          code: "NOTE_NOT_FOUND",
          message: `note "${params.id}" not found. It may have been deleted or never existed.`,
        })
      }
      throw error
    }

    const session = await Session.get(ctx.sessionID)
    const decision = NoteBlueprintPolicy.evaluateWrite({
      planMode: session.blueprint?.planMode === true,
      action: "edit",
      existingKind: existing.kind ?? "note",
    })
    if (!decision.allowed) {
      return NoteBlueprintPolicy.blockedResult({ action: decision.action, id: params.id, title: existing.title })
    }

    const beforeDoc = NoteDocument.normalize(existing.content)
    const beforeHash = NoteDocument.hash(beforeDoc)

    if (existing.version !== params.baseVersion) {
      return errorResult({
        id: params.id,
        code: "VERSION_MISMATCH",
        message: `note version changed since note_read. Expected ${params.baseVersion}, current ${existing.version}.`,
        note: existing,
      })
    }

    if (params.baseDocHash && params.baseDocHash !== beforeHash) {
      return errorResult({
        id: params.id,
        code: "DOC_HASH_MISMATCH",
        message: `note docHash changed since note_read. Expected ${params.baseDocHash}, current ${beforeHash}.`,
        note: existing,
      })
    }

    let nextDoc = beforeDoc
    const touched = new Set<string>()
    const operationResults: OperationSemanticResult[] = []

    try {
      for (const [opIndex, op] of params.ops.entries()) {
        const stepBeforeDoc = nextDoc
        const stepBeforeBlocks = NoteDocument.listBlocks(stepBeforeDoc)
        const result = applyOperation(stepBeforeDoc, op)
        nextDoc = result.doc
        const stepAfterBlocks = NoteDocument.listBlocks(nextDoc)
        operationResults.push(
          buildOperationResult({
            opIndex,
            action: op.action,
            beforeDoc: stepBeforeDoc,
            afterDoc: nextDoc,
            beforeBlocks: stepBeforeBlocks,
            afterBlocks: stepAfterBlocks,
            seed: result.semanticSeed,
          }),
        )
        for (const id of result.touched) touched.add(id)
      }

      const validation = NoteDocument.validate(nextDoc)
      if (!validation.ok) {
        return errorResult({
          id: params.id,
          code: "INVALID_DOCUMENT",
          message: validation.errors.join("; "),
          note: existing,
          blockIds: [...touched],
        })
      }
      nextDoc = validation.doc
    } catch (error) {
      const failedOpIndex = operationResults.length
      const failedAction = params.ops[failedOpIndex]?.action
      return errorResult({
        id: params.id,
        code: "EDIT_PRECONDITION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        note: existing,
        blockIds: [...new Set(params.ops.flatMap(targetIds))],
        failedOpIndex,
        failedAction,
      })
    }

    const changed = changedBlocks(beforeDoc, nextDoc, touched)
    const nextHash = NoteDocument.hash(nextDoc)
    const warnings = operationResults.flatMap((result) =>
      result.warnings.map((warning) => `Operation ${result.opIndex + 1}: ${warning}`),
    )
    const directChangedBlockIds = new Set(
      operationResults.flatMap((result) => result.directChangedBlocks.map((block) => block.id)),
    )
    const ancestorChangedBlockIds = new Set(
      operationResults.flatMap((result) => result.ancestorChangedBlocks.map((block) => block.id)),
    )
    const unexpectedChangedBlockIds = new Set(
      operationResults.flatMap((result) => result.unexpectedChangedBlocks.map((block) => block.id)),
    )
    const changeSummary = {
      operations: params.ops.length,
      changedBlocks: changed.length,
      directChangedBlocks: directChangedBlockIds.size,
      ancestorChangedBlocks: ancestorChangedBlockIds.size,
      unexpectedChangedBlocks: unexpectedChangedBlockIds.size,
      noopOperations: operationResults.filter((result) => result.status === "noop").length,
    }

    if (!params.dryRun) {
      try {
        existing = await NoteStore.updateAny(ScopeContext.current.scope.id, params.id, {
          content: nextDoc,
          expectedVersion: existing.version,
        })
      } catch (error) {
        if (error instanceof NoteError.Conflict) {
          return errorResult({
            id: params.id,
            code: "WRITE_CONFLICT",
            message: `note changed while applying edit. Expected ${params.baseVersion}, current ${error.data.note.version}.`,
            note: error.data.note,
          })
        }
        if (error instanceof Storage.NotFoundError) {
          return errorResult({
            id: params.id,
            code: "NOTE_DELETED",
            message: `note "${params.id}" was deleted while the edit was in progress.`,
          })
        }
        throw error
      }
    }

    const finalVersion = existing.version
    return {
      title: existing.title,
      output: [
        params.dryRun ? "Note edit dry run succeeded." : "Note edited successfully.",
        `ID: ${params.id}`,
        `Title: ${existing.title}`,
        `Version: ${finalVersion}`,
        `DocHash: ${nextHash}`,
        `Operations applied: ${params.ops.length}`,
        `Changed blocks: ${changed.length}`,
        `Warnings: ${warnings.length ? warnings.join("; ") : "none"}`,
        "",
        operationResults.map(renderOperationResult).join("\n\n"),
        "",
        "Changed blocks:",
        JSON.stringify(
          changed.map(blockPreview).filter((block): block is BlockPreview => !!block),
          null,
          2,
        ),
      ].join("\n"),
      metadata: {
        id: params.id,
        title: existing.title,
        dryRun: params.dryRun,
        version: finalVersion,
        docHash: nextHash,
        opCount: params.ops.length,
        changedBlockIds: changed.map((block) => block.id),
        changedBlocks: changed,
        operationResults,
        changeSummary,
        warnings,
      } as Record<string, any>,
    }
  },
})
