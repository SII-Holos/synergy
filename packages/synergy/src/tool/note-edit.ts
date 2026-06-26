import z from "zod"
import { Tool } from "./tool"
import { NoteDocument, NoteError, NoteStore } from "../note"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import DESCRIPTION from "./note-edit.txt"

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
}) {
  const doc = input.note ? NoteDocument.normalize(input.note.content) : undefined
  const docHash = doc ? NoteDocument.hash(doc) : undefined
  return {
    title: "Error",
    output: [
      `Error: ${input.message}`,
      `Code: ${input.code}`,
      `ID: ${input.id}`,
      ...(input.note ? [`Current version: ${input.note.version}`] : []),
      ...(docHash ? [`Current docHash: ${docHash}`] : []),
      ...(doc ? ["Current blocks:", JSON.stringify(compactBlocks(doc, input.blockIds), null, 2)] : []),
    ].join("\n"),
    metadata: {
      id: input.id,
      errorCode: input.code,
      currentVersion: input.note?.version,
      currentDocHash: docHash,
      blocks: doc ? compactBlocks(doc, input.blockIds) : undefined,
    } as Record<string, any>,
  }
}

function blockMap(doc: NoteDocument.Node) {
  return new Map(NoteDocument.listBlocks(doc, { includeJson: true }).map((block) => [block.id, block]))
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

function applyOperation(doc: NoteDocument.Node, op: Operation): { doc: NoteDocument.Node; touched: string[] } {
  switch (op.action) {
    case "replaceBlock": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "replaceBlock")
      const nodes = NoteDocument.parseContent(op.content)
      return { doc: NoteDocument.replaceBlock(doc, block, nodes), touched: [block.id] }
    }
    case "insertBefore": {
      const block = resolveById(doc, op.blockId, undefined, "insertBefore")
      const nodes = NoteDocument.parseContent(op.content)
      return { doc: NoteDocument.insertNearBlock(doc, block, nodes, "before"), touched: [block.id] }
    }
    case "insertAfter": {
      const block = resolveById(doc, op.blockId, undefined, "insertAfter")
      const nodes = NoteDocument.parseContent(op.content)
      return { doc: NoteDocument.insertNearBlock(doc, block, nodes, "after"), touched: [block.id] }
    }
    case "deleteBlock": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "deleteBlock")
      return { doc: NoteDocument.deleteBlock(doc, block), touched: [block.id] }
    }
    case "setAttrs": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "setAttrs")
      return { doc: NoteDocument.setAttrs(doc, block, op.attrs), touched: [block.id] }
    }
    case "replaceText": {
      const block = resolveById(doc, op.blockId, op.expectedHash, "replaceText")
      return {
        doc: NoteDocument.replaceText(doc, block, {
          find: op.find,
          range: op.range,
          replacement: op.replacement,
          occurrence: op.occurrence,
        }),
        touched: [block.id],
      }
    }
    case "updateTableCell": {
      const nodes = NoteDocument.parseContent(op.content)
      const result = NoteDocument.updateTableCell(doc, {
        tableId: op.tableId,
        cellId: op.cellId,
        row: op.row,
        col: op.col,
        content: nodes,
      })
      if (op.expectedHash) {
        requireHash(result.cell, op.expectedHash, "updateTableCell")
      }
      return { doc: result.doc, touched: [result.cell.id] }
    }
    case "replaceRange": {
      const start = resolveById(doc, op.startBlockId, op.expectedStartHash, "replaceRange start")
      const end = resolveById(doc, op.endBlockId, op.expectedEndHash, "replaceRange end")
      const nodes = NoteDocument.parseContent(op.content)
      return { doc: NoteDocument.replaceRange(doc, start, end, nodes), touched: [start.id, end.id] }
    }
  }
}

function changedBlocks(before: NoteDocument.Node, after: NoteDocument.Node, touched: Set<string>) {
  const beforeHashes = new Map(NoteDocument.listBlocks(before).map((block) => [block.id, block.hash]))
  return NoteDocument.listBlocks(after).filter(
    (block) => touched.has(block.id) || beforeHashes.get(block.id) !== block.hash,
  )
}

export const NoteEditTool = Tool.define("note_edit", {
  description: DESCRIPTION,
  parameters,
  async execute(params: Params) {
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

    try {
      for (const op of params.ops) {
        const result = applyOperation(nextDoc, op)
        nextDoc = result.doc
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
      return errorResult({
        id: params.id,
        code: "EDIT_PRECONDITION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        note: existing,
        blockIds: [...new Set(params.ops.flatMap(targetIds))],
      })
    }

    const changed = changedBlocks(beforeDoc, nextDoc, touched)
    const nextHash = NoteDocument.hash(nextDoc)

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
        JSON.stringify(
          changed.map((block) => ({
            id: block.id,
            type: block.type,
            path: block.pathLabel,
            hash: block.hash,
            summary: block.summary,
            row: block.row,
            col: block.col,
            tableId: block.tableId,
          })),
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
      } as Record<string, any>,
    }
  },
})
