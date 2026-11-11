import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
  OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import type { RuntimeIdentity } from "../home"
import { denied, withMemberExecution } from "../execution-source"
import { knowledgeTransport } from "../knowledge-source"
import { knowledgeFiles, stageKnowledgeSelection, type ActiveKnowledge, type KnowledgeTransport } from "../knowledge"

const Parameters = z.strictObject({
  input: z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("list"), cursor: z.string().optional() }),
    Knowledge.Reference.extend({ operation: z.literal("files"), cursor: Protocol.Digest.optional() }),
    Knowledge.Reference.extend({
      operation: z.literal("read"),
      fileID: Protocol.Digest,
      offset: z.number().int().nonnegative().safe().default(0),
      length: z
        .number()
        .int()
        .min(1)
        .max(128 * 1024)
        .default(32 * 1024),
    }),
    z.strictObject({
      operation: z.literal("search"),
      q: z.string().min(1).max(1000),
      cursor: z.string().max(4096).optional(),
    }),
  ]),
})
const SearchCursor = z.strictObject({
  manifestHash: Protocol.Digest,
  itemID: z.string(),
  afterFileID: Protocol.Digest.optional(),
  offset: z.number().int().nonnegative().safe(),
})

async function search(
  active: ActiveKnowledge,
  transport: KnowledgeTransport,
  q: string,
  encoded: string | undefined,
  signal: AbortSignal,
) {
  const cursor = encoded ? SearchCursor.parse(JSON.parse(Buffer.from(encoded, "base64url").toString())) : undefined
  if (cursor && cursor.manifestHash !== active.selection.manifestHash)
    throw denied("Knowledge selection changed; restart the search without its cursor")
  let index = cursor ? active.releases.findIndex(({ release }) => release.itemID === cursor.itemID) : 0
  if (index < 0) throw denied("Search cursor does not belong to the selected knowledge manifest")
  let afterFileID = cursor?.afterFileID
  let offset = cursor?.offset ?? 0
  let remaining = 256 * 1024
  const items: Array<{
    reference: Knowledge.Reference
    title: string
    path: string
    fileID: string
    offset: number
    snippet: string
  }> = []
  const needle = q.toLocaleLowerCase()
  while (index < active.releases.length && remaining > 0 && items.length < 25) {
    signal.throwIfAborted()
    const release = active.releases[index]!.release
    const reference = Knowledge.Reference.parse({
      itemID: release.itemID,
      version: release.version,
      manifestHash: release.manifestHash,
    })
    const page = await knowledgeFiles(active, reference, { cursor: afterFileID, limit: 1 })
    const file = page.items[0]
    if (!file) {
      index++
      afterFileID = undefined
      offset = 0
      continue
    }
    const textual = file.mediaType.startsWith("text/") || /(?:json|xml|yaml)/.test(file.mediaType)
    if (textual && offset < file.bytes) {
      const overlap = Math.min(offset, Buffer.byteLength(q) + 4)
      const start = offset - overlap
      const length = overlap + Math.min(32 * 1024 - overlap, remaining, file.bytes - offset)
      const chunk = await transport.content(reference, file.fileID, start, length, signal)
      const bytes = Buffer.from(chunk.data, "base64url")
      if (!bytes.length || chunk.totalBytes !== file.bytes || chunk.sha256 !== file.sha256)
        throw denied("Search content no longer matches its published file")
      const text = bytes.toString("utf8")
      const match = text.toLocaleLowerCase().indexOf(needle)
      if (match >= 0)
        items.push({
          reference,
          title: release.title,
          path: file.path,
          fileID: file.fileID,
          offset: start + Buffer.byteLength(text.slice(0, match)),
          snippet: text.slice(Math.max(0, match - 100), match + q.length + 300),
        })
      offset = start + bytes.length
      remaining -= bytes.length - overlap
    } else offset = file.bytes
    if (offset >= file.bytes) {
      offset = 0
      if (page.cursor) afterFileID = file.fileID
      else {
        index++
        afterFileID = undefined
      }
    }
  }
  const next =
    index < active.releases.length
      ? Buffer.from(
          JSON.stringify({
            manifestHash: active.selection.manifestHash,
            itemID: active.releases[index]!.release.itemID,
            afterFileID,
            offset,
          }),
        ).toString("base64url")
      : undefined
  return { items, ...(next ? { cursor: next } : {}) }
}

export function createMemberKnowledgeTool(identity: RuntimeIdentity): Tool.Info {
  return Tool.define<typeof Parameters, Record<string, unknown>>(
    "organization_knowledge",
    {
      description:
        "Read or search material and Skill files explicitly selected for this organization Session. Start with list, then files for an exact itemID/version/manifestHash. Read text in bounded byte ranges; use returned cursors to continue lists or content search. Cite the exact version and hash. A changed selection requires a fresh list; unavailable access must not be replaced with a private local file.",
      parameters: Parameters,
      async execute({ input }, ctx) {
        await ctx.ask({
          permission: "organization_knowledge",
          patterns: [input.operation === "files" || input.operation === "read" ? input.itemID : "*"],
          metadata: { operation: input.operation },
        })
        return withMemberExecution(
          identity,
          { sessionID: ctx.sessionID, signal: ctx.abort },
          async (resolution, signal) => {
            const transport = knowledgeTransport(resolution)
            const active = await stageKnowledgeSelection({
              root: RuntimeContext.current().host.root,
              orgID: identity.orgID,
              projectID: resolution.session.organization!.projectID,
              sessionID: ctx.sessionID,
              sourceSessionID: resolution.accepted.sessionID,
              transport,
              signal,
            })
            if (input.operation === "list") {
              const result = await transport.selection(
                { cursor: input.cursor, manifestHash: active.selection.manifestHash },
                signal,
              )
              return {
                title: "Organization knowledge · list",
                output: JSON.stringify(result),
                metadata: { operation: input.operation, cursor: result.cursor },
              }
            }
            if (input.operation === "search") {
              const result = await search(active, transport, input.q, input.cursor, signal)
              await ctx.captureResult?.({
                operation: "search",
                query: input.q,
                manifestHash: active.selection.manifestHash,
                ...result,
              })
              return {
                title: "Organization knowledge · search",
                output: JSON.stringify(result),
                metadata: { operation: input.operation, cursor: result.cursor, truncated: !!result.cursor },
              }
            }
            const reference = Knowledge.Reference.parse({
              itemID: input.itemID,
              version: input.version,
              manifestHash: input.manifestHash,
            })
            const selected = active.releases.find(
              ({ release }) =>
                release.itemID === reference.itemID &&
                release.version === reference.version &&
                release.manifestHash === reference.manifestHash,
            )
            if (!selected) throw denied("Knowledge version is not selected for this Session; list its current versions")
            if (input.operation === "files") {
              const result = await transport.files(reference, { cursor: input.cursor }, signal)
              return {
                title: "Organization knowledge · files",
                output: JSON.stringify(result),
                metadata: {
                  operation: input.operation,
                  title: selected.release.title,
                  ...reference,
                  cursor: result.cursor,
                },
              }
            }
            const file = await findFile(active, reference, input.fileID)
            if (!file) throw denied("File is not part of this selected knowledge version; use files to find its fileID")
            const chunk = await transport.content(reference, file.fileID, input.offset, input.length, signal)
            const bytes = Buffer.from(chunk.data, "base64url")
            const textual = file.mediaType.startsWith("text/") || /(?:json|xml|yaml)/.test(file.mediaType)
            const observation = {
              reference,
              path: file.path,
              fileID: file.fileID,
              sha256: chunk.sha256,
              offset: chunk.offset,
              bytes: bytes.length,
              totalBytes: chunk.totalBytes,
              encoding: textual ? "utf8" : "base64url",
              content: textual ? bytes.toString("utf8") : chunk.data,
              nextOffset: input.offset + bytes.length < chunk.totalBytes ? input.offset + bytes.length : undefined,
            }
            await ctx.captureResult?.(observation)
            return {
              title: "Organization knowledge · read",
              output: JSON.stringify(observation),
              metadata: {
                operation: input.operation,
                title: selected.release.title,
                path: file.path,
                ...reference,
                fileID: file.fileID,
                offset: input.offset,
                bytes: bytes.length,
                truncated: observation.nextOffset !== undefined,
              },
            }
          },
        )
      },
    },
    { requiresWorkspace: false, exposure: { mode: "resident" } },
  )
}

async function findFile(
  active: ActiveKnowledge,
  reference: Knowledge.Reference,
  fileID: string,
): Promise<Publication.File | undefined> {
  let cursor: string | undefined
  do {
    const page = await knowledgeFiles(active, reference, { cursor, limit: 100 })
    const file = page.items.find((file) => file.fileID === fileID)
    if (file) return file
    cursor = page.cursor
  } while (cursor)
}
