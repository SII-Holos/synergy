import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

export interface NoteWriteExtensions {}

export namespace NoteDocumentKinds {
  export type Document = { id?: string; kind?: string; title?: string } & Record<string, unknown>
  export type WriteAction = "create" | "update" | "edit"
  export type Blocked = { title: string; output: string; metadata: Record<string, unknown> }
  export interface Contribution {
    kind: string
    title: string
    fields: { info: z.ZodRawShape; create: z.ZodRawShape; patch: z.ZodRawShape }
    project?(fields: Record<string, unknown>): void
    normalize?(document: Document): void
    create?(document: Document, input: Document): void
    update?(document: Document, patch: Document): void
    tool?: {
      write: z.ZodRawShape
      description: string
      input?(input: Record<string, unknown>): Document | undefined
      guard?(input: {
        sessionID: string
        action: WriteAction
        existing?: Document
        requestedKind?: string
        title?: string
      }): Promise<Blocked | undefined>
      details?(document: Document): string[]
      metadata?(document: Document): Record<string, unknown>
    }
  }

  const state = RuntimeContext.state(() => ({ kinds: new Map<string, Contribution>() }))

  export function register(contribution: Contribution) {
    const existing = state().kinds.get(contribution.kind)
    if (existing === contribution) return
    RuntimeContext.assertCompositionOpen(`Note document kind ${contribution.kind}`)
    if (contribution.kind === "note" || existing)
      throw new Error(`Note document kind ${contribution.kind} is already registered`)
    for (const entry of state().kinds.values()) {
      for (const field of Object.keys(contribution.fields.info))
        if (field in entry.fields.info) throw new Error(`Note field ${field} is already owned by ${entry.kind}`)
    }
    state().kinds.set(contribution.kind, contribution)
  }

  export function available(kind: string | undefined) {
    return !kind || kind === "note" || state().kinds.has(kind)
  }

  export function require(document: Document) {
    if (!available(document.kind)) throw new Storage.NotFoundError({ message: `Note not found: ${document.id}` })
  }

  export function kindSchema(all = false) {
    return ConfigExtensions.dynamicSchema(() =>
      z.enum([...(all ? ["all"] : []), "note", ...state().kinds.keys()] as [string, ...string[]]),
    )
  }

  export function schema<S extends z.ZodRawShape>(base: z.ZodObject<S>, surface: "info" | "create" | "patch") {
    const schema = ConfigExtensions.dynamicSchema(() => {
      const shape: z.ZodRawShape = { ...base.shape, kind: kindSchema().optional() }
      for (const contribution of state().kinds.values()) Object.assign(shape, contribution.fields[surface])
      return (surface === "info" ? z.object(shape) : z.strictObject(shape)).meta(base.meta() ?? {})
    }) as z.ZodObject<S>
    z.globalRegistry.add(schema, base.meta() ?? {})
    return schema
  }

  export function fields() {
    return [...state().kinds.values()].flatMap((contribution) => Object.keys(contribution.fields.info))
  }

  export function normalize(document: Document) {
    state()
      .kinds.get(document.kind ?? "note")
      ?.normalize?.(document)
  }

  export function project(document: Document): Document {
    const projected = { ...document }
    for (const owner of state().kinds.values()) {
      if (!owner.project) continue
      const keys = Object.keys(owner.fields.info).filter((key) => Object.hasOwn(document, key))
      const fields = structuredClone(Object.fromEntries(keys.map((key) => [key, document[key]])))
      owner.project(fields)
      for (const key of keys) {
        if (Object.hasOwn(fields, key)) projected[key] = fields[key]
        else delete projected[key]
      }
    }
    return projected
  }

  export function create(document: Document, input: Document) {
    require(document)
    state()
      .kinds.get(document.kind ?? "note")
      ?.create?.(document, input)
  }

  export function update(document: Document, patch: Document) {
    require(document)
    if (patch.kind !== undefined && patch.kind !== document.kind) {
      require({ ...document, kind: patch.kind })
      const previous = state().kinds.get(document.kind ?? "note")
      if (previous) for (const field of Object.keys(previous.fields.info)) delete document[field]
      document.kind = patch.kind
    }
    state()
      .kinds.get(document.kind ?? "note")
      ?.update?.(document, patch)
  }

  export function title(kind: string | undefined) {
    return state().kinds.get(kind ?? "note")?.title ?? "Note"
  }
  export function details(document: Document) {
    return (
      state()
        .kinds.get(document.kind ?? "note")
        ?.tool?.details?.(document) ?? []
    )
  }
  export function metadata(document: Document) {
    return (
      state()
        .kinds.get(document.kind ?? "note")
        ?.tool?.metadata?.(document) ?? {}
    )
  }

  export function toolSchema<S extends z.ZodRawShape>(base: z.ZodObject<S>) {
    return ConfigExtensions.dynamicSchema(() =>
      z.strictObject({
        ...base.shape,
        kind: kindSchema().optional(),
        ...Object.assign({}, ...[...state().kinds.values()].map((contribution) => contribution.tool?.write ?? {})),
      }),
    ) as z.ZodObject<S & { [K in keyof NoteWriteExtensions]: Extract<NoteWriteExtensions[K], z.ZodType> }>
  }

  export function filterSchema<S extends z.ZodRawShape>(base: z.ZodObject<S>) {
    return ConfigExtensions.dynamicSchema(() =>
      z.object({ ...base.shape, kind: kindSchema(true).default("all") }),
    ) as z.ZodObject<S>
  }

  export function toolDescription(base: string) {
    return [base, ...[...state().kinds.values()].flatMap((contribution) => contribution.tool?.description ?? [])].join(
      "\n\n",
    )
  }

  export function toolInput(input: Record<string, unknown>): Document {
    for (const contribution of state().kinds.values()) {
      const result = contribution.tool?.input?.(input)
      if (result) return result
    }
    return typeof input.kind === "string" ? { kind: input.kind } : {}
  }

  export async function guard(input: {
    sessionID: string
    action: WriteAction
    existing?: Document
    requestedKind?: string
    title?: string
  }) {
    const kinds = new Set([input.existing?.kind, input.requestedKind])
    for (const kind of kinds) {
      if (!kind) continue
      const result = await state().kinds.get(kind)?.tool?.guard?.(input)
      if (result) return result
    }
  }
}
