import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { RolloutEvidence } from "@ericsanchezok/synergy-harness/rollout"
import { ExecutionJson } from "./json-sections"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"

export namespace ExecutionContent {
  export type Source = {
    mediaType: string
    bytes: number
    status: "partial" | "complete"
    contentVersion: string
    sha256: string | null
    read: (offset: number, limit: number) => Promise<z.infer<typeof RolloutEvidence.Content>>
    stream: () => AsyncIterable<Uint8Array>
  }
  export const Query = z.object({
    field: z.string().min(1).max(100),
    runID: z.string().optional(),
    version: z.string().max(4096).optional(),
  })
  export const PageQuery = Query.extend({
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  export const SearchQuery = PageQuery.extend({
    query: z.string().min(1).max(500),
    caseSensitive: z.preprocess((value) => (value === "false" ? false : value), z.coerce.boolean()).default(true),
  })
  export const Section = z.object({
    path: z.array(z.string()),
    kind: z.enum(["object", "array", "string", "number", "boolean", "null"]),
    offset: z.number(),
    bytes: z.number(),
    role: z.string().optional(),
    preview: z.string(),
  })
  export const Sections = z
    .object({
      contentVersion: z.string(),
      format: z.enum(["json", "text", "partial"]),
      items: z.array(Section),
      total: z.number(),
      nextCursor: z.string().nullable(),
      truncated: z.boolean(),
    })
    .meta({ ref: "ExecutionContentSections" })
  export const Search = z
    .object({
      contentVersion: z.string(),
      status: z.enum(["partial", "complete"]),
      items: z.array(z.object({ offset: z.number(), bytes: z.number(), preview: z.string() })),
      nextCursor: z.string().nullable(),
    })
    .meta({ ref: "ExecutionContentSearch" })
  const cache = RuntimeContext.state(() => ({
    entries: new Map<string, { value: Awaited<ReturnType<typeof ExecutionJson.index>>; bytes: number }>(),
    bytes: 0,
  }))
  function cursor(version: string, query: string, offset: number) {
    return Buffer.from(JSON.stringify({ version, query, offset })).toString("base64url")
  }
  function position(input: string | undefined, version: string, query: string) {
    if (!input) return 0
    const value = z
      .object({ version: z.string(), query: z.string(), offset: z.number().int().nonnegative() })
      .parse(JSON.parse(Buffer.from(input, "base64url").toString()))
    if (value.version !== version || value.query !== query)
      throw new RangeError("Execution content cursor does not match its version and query")
    return value.offset
  }
  export async function sections(source: Source, input: z.infer<typeof PageQuery>, signal?: AbortSignal) {
    const offset = position(input.cursor, source.contentVersion, "sections")
    if (source.status === "partial" || !source.mediaType.includes("json"))
      return Sections.parse({
        contentVersion: source.contentVersion,
        format: source.status === "partial" ? "partial" : "text",
        items: [],
        total: 0,
        nextCursor: null,
        truncated: false,
      })
    const state = cache()
    const key = ScopeContext.current.scope.id + ":" + source.contentVersion
    let value = state.entries.get(key)?.value
    if (!value) {
      try {
        value = await ExecutionJson.index(source.stream(), signal)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return Sections.parse({
          contentVersion: source.contentVersion,
          format: "text",
          items: [],
          total: 0,
          nextCursor: null,
          truncated: false,
        })
      }
      const bytes = Buffer.byteLength(JSON.stringify(value))
      if (!state.entries.has(key) && bytes <= 8 * 1024 * 1024) {
        while (state.bytes + bytes > 8 * 1024 * 1024 && state.entries.size) {
          const [key, entry] = state.entries.entries().next().value!
          state.entries.delete(key)
          state.bytes -= entry.bytes
        }
        state.entries.set(key, { value, bytes })
        state.bytes += bytes
      }
    }
    const items = value.items.slice(offset, offset + input.limit)
    return Sections.parse({
      contentVersion: source.contentVersion,
      format: "json",
      items,
      total: value.items.length,
      nextCursor:
        offset + items.length < value.items.length
          ? cursor(source.contentVersion, "sections", offset + items.length)
          : null,
      truncated: value.truncated,
    })
  }
  export async function value(source: Source, path: string[], signal?: AbortSignal): Promise<unknown> {
    let next: string | undefined
    let section: z.infer<typeof Section> | undefined
    do {
      const page = await sections(source, PageQuery.parse({ field: "request", cursor: next, limit: 500 }), signal)
      section = page.items.find((item) => JSON.stringify(item.path) === JSON.stringify(path))
      next = page.nextCursor ?? undefined
    } while (!section && next)
    if (!section || section.bytes > 8 * 1024 * 1024) return undefined
    const parts: string[] = []
    for (let offset = section.offset; offset < section.offset + section.bytes; ) {
      signal?.throwIfAborted()
      const page = await source.read(offset, Math.min(65_536, section.offset + section.bytes - offset))
      parts.push(page.text)
      offset = page.nextOffset ?? source.bytes
    }
    return JSON.parse(parts.join(""))
  }
  export async function search(source: Source, input: z.infer<typeof SearchQuery>, signal?: AbortSignal) {
    const fingerprint = JSON.stringify([input.query, input.caseSensitive])
    let offset = position(input.cursor, source.contentVersion, fingerprint)
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.caseSensitive ? "gu" : "giu")
    const items: Array<{ offset: number; bytes: number; preview: string }> = []
    let carry = ""
    let carryOffset = offset
    let next: number | null = null
    while (offset < source.bytes) {
      signal?.throwIfAborted()
      const page = await source.read(offset, 65_536)
      const text = carry + page.text
      const base = carry ? carryOffset : offset
      const safe = page.nextOffset === null ? text.length : Math.max(0, text.length - input.query.length - 2)
      pattern.lastIndex = 0
      let consumed = 0
      for (let match = pattern.exec(text); match && match.index < safe; match = pattern.exec(text)) {
        const start = base + Buffer.byteLength(text.slice(0, match.index))
        const bytes = Buffer.byteLength(match[0])
        items.push({
          offset: start,
          bytes,
          preview: text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 100),
        })
        consumed = match.index + match[0].length
        if (items.length === input.limit) {
          next = start + bytes
          break
        }
      }
      if (next !== null) break
      let retained = Math.max(safe, consumed)
      if (retained && retained < text.length && /[\uDC00-\uDFFF]/.test(text[retained])) retained--
      carry = text.slice(retained)
      carryOffset = base + Buffer.byteLength(text.slice(0, retained))
      offset = page.nextOffset ?? source.bytes
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return Search.parse({
      contentVersion: source.contentVersion,
      status: source.status,
      items,
      nextCursor: next !== null && next < source.bytes ? cursor(source.contentVersion, fingerprint, next) : null,
    })
  }
}
