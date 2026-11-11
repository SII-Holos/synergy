import { RuntimeContext } from "../lifecycle/context"
import { z } from "zod"
import { ConfigExtensions } from "../config/extensions"
import type { SessionExtensionShape } from "./types"
import { WorkflowKindRegistry } from "./workflow-kind-registry"

export namespace SessionSchemaRegistry {
  export interface TransferMutation {
    source: Readonly<Record<string, unknown>>
    previous?: Readonly<Record<string, unknown>>
    parent?: Readonly<Record<string, unknown>>
    sessionID: string
    rootSessionID: string
    handoffID: string
  }
  type ComposedShape<S extends z.ZodRawShape> = Omit<S, keyof SessionExtensionShape | "workflow"> &
    Omit<SessionExtensionShape, "workflow"> & { workflow: z.ZodOptional<z.ZodType<WorkflowKindRegistry.Workflow>> }
  export interface Contribution {
    shape: z.ZodRawShape
    transferOwner?: string
    inherit?: readonly string[]
    validateMutation?(input: {
      previous?: Readonly<Record<string, unknown>>
      next: Readonly<Record<string, unknown>>
      parent?: Readonly<Record<string, unknown>>
    }): void | Promise<void>
    project?(fields: Record<string, unknown>): void
    projectionKey?(): string
    isBackground?(input: Record<string, unknown>): boolean
    created?(input: Record<string, unknown>): Promise<void>
    /** Session navigation identity this owner contributes to
     * `SessionNavEntry` (for example the Blueprint loop binding). Runs
     * synchronously inside session transactions, so it may only read the
     * already-parsed session. */
    navIdentity?(input: Record<string, unknown>): Record<string, unknown> | undefined
    normalizeImport?(input: Record<string, unknown>, mode: "transcript" | "archive"): void
    adoptTransfer?(input: TransferMutation): Record<string, unknown> | Promise<Record<string, unknown>>
    validateTransfer?(input: TransferMutation & { next: Readonly<Record<string, unknown>> }): void | Promise<void>
  }
  const state = RuntimeContext.state(() => ({
    owners: new Map<string, Contribution>(),
    generation: 0,
    schemas: new WeakMap<object, { generation: number; workflowGeneration: number; schema: z.ZodObject }>(),
  }))

  export function register(id: string, contribution: Contribution): void {
    const existing = state().owners.get(id)
    if (existing === contribution) return
    if (existing) throw new Error(`Session domain ${id} is already registered`)
    ConfigExtensions.assertRegistrationOpen(id)
    if (contribution.transferOwner) z.string().min(1).max(256).parse(contribution.transferOwner)
    if (!!contribution.adoptTransfer !== !!contribution.validateTransfer)
      throw new Error(`Session domain ${id} must own both transfer adoption and validation`)
    for (const key of contribution.inherit ?? []) {
      if (!Object.hasOwn(contribution.shape, key))
        throw new Error(`Session domain ${id} cannot inherit unowned field ${key}`)
    }
    for (const [otherID, other] of state().owners) {
      if (otherID === id) continue
      for (const key of Object.keys(contribution.shape)) {
        if (key in other.shape) throw new Error(`Session field ${key} is already owned by ${otherID}`)
      }
    }
    state().owners.set(id, contribution)
    state().generation++
  }

  export function compose<S extends z.ZodRawShape>(base: z.ZodObject<S>): z.ZodObject<ComposedShape<S>> {
    return ConfigExtensions.dynamicSchema(() => {
      const instance = state()
      const cached = instance.schemas.get(base)
      const workflowGeneration = WorkflowKindRegistry.generation()
      if (cached?.generation === instance.generation && cached.workflowGeneration === workflowGeneration)
        return cached.schema
      const shape: Record<string, z.ZodRawShape[string]> = { ...base.shape }
      for (const owner of state().owners.values()) {
        for (const key of Object.keys(owner.shape)) {
          if (key in base.shape && key !== "workflow")
            throw new Error(`Session field ${key} is already owned by the harness`)
        }
        Object.assign(shape, owner.shape)
      }
      const workflow = WorkflowKindRegistry.schema()
      if (workflow) Object.assign(shape, { workflow: workflow.optional() })
      else delete shape.workflow
      const schema = z.object(shape)
      instance.schemas.set(base, { generation: instance.generation, workflowGeneration, schema })
      return schema
    }) as z.ZodObject<ComposedShape<S>>
  }

  export function isBackground(input: object | undefined): boolean {
    if (!input) return false
    return [...state().owners.values()].some((owner) => owner.isBackground?.(input as Record<string, unknown>))
  }

  export function projectionKey(): string {
    return JSON.stringify({
      owners: [...state().owners.keys()].sort(),
      workflows: WorkflowKindRegistry.ids(),
      projections: [...state().owners]
        .flatMap(([id, owner]) => (owner.projectionKey ? [[id, owner.projectionKey()]] : []))
        .sort(([a], [b]) => a.localeCompare(b)),
    })
  }

  export function projectInput(input: unknown): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input
    const projected = { ...input } as Record<string, unknown>
    const workflow = projected.workflow
    if (workflow && typeof workflow === "object" && "kind" in workflow) {
      const extension = "extension" in workflow ? workflow.extension : undefined
      const kind =
        workflow.kind === "extension" && extension && typeof extension === "object" && "kind" in extension
          ? extension.kind
          : workflow.kind
      if (typeof kind === "string" && !WorkflowKindRegistry.get(kind)) delete projected.workflow
    }
    for (const owner of state().owners.values()) {
      if (!owner.project) continue
      const keys = Object.keys(owner.shape).filter((key) => Object.hasOwn(projected, key))
      const fields = structuredClone(Object.fromEntries(keys.map((key) => [key, projected[key]])))
      owner.project(fields)
      for (const key of keys) {
        if (Object.hasOwn(fields, key)) projected[key] = fields[key]
        else delete projected[key]
      }
    }
    return projected
  }

  export function navIdentity(input: object): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    const projected = projectInput(input) as Record<string, unknown>
    for (const owner of state().owners.values()) Object.assign(result, owner.navIdentity?.(projected))
    return result
  }

  export async function created(input: object): Promise<void> {
    for (const owner of state().owners.values()) await owner.created?.(input as Record<string, unknown>)
  }

  export function normalizeImport(input: object, mode: "transcript" | "archive"): void {
    for (const owner of state().owners.values()) owner.normalizeImport?.(input as Record<string, unknown>, mode)
  }

  export async function validateMutation(input: { previous?: object; next: object; parent?: object }) {
    for (const owner of state().owners.values()) {
      if (owner.validateMutation)
        await owner.validateMutation(
          structuredClone(input) as Parameters<NonNullable<Contribution["validateMutation"]>>[0],
        )
    }
  }

  export function transferOwners(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return []
    const fields = input as Record<string, unknown>
    return [
      ...new Set(
        [...state().owners.values()].flatMap((owner) =>
          owner.transferOwner && Object.keys(owner.shape).some((key) => fields[key] !== undefined)
            ? [owner.transferOwner]
            : [],
        ),
      ),
    ].sort()
  }

  export async function adoptTransfer(input: TransferMutation) {
    const { SessionTransferEpochs } = await import("./transfer-epochs")
    const binding = SessionTransferEpochs.assertActivation({ sessionID: input.sessionID, handoffID: input.handoffID })
    const identity = z
      .object({ id: z.literal(input.sessionID), scope: z.object({ id: z.literal(binding.scopeID) }) })
      .safeParse(input.source)
    if (!identity.success || (binding.rootSessionID ?? binding.sessionID) !== input.rootSessionID)
      throw new Error("Session transfer adoption changed its reserved identity, Scope or aggregate root")
    const next: Record<string, unknown> = { ...structuredClone(input.source) }
    for (const [id, owner] of state().owners) {
      if (!owner.adoptTransfer) continue
      const fields = await owner.adoptTransfer(structuredClone(input))
      for (const key of Object.keys(fields))
        if (!Object.hasOwn(owner.shape, key)) throw new Error(`Session domain ${id} cannot adopt unowned field ${key}`)
      for (const key of Object.keys(owner.shape)) {
        if (Object.hasOwn(fields, key)) next[key] = structuredClone(fields[key])
        else delete next[key]
      }
    }
    for (const owner of state().owners.values()) {
      const mutation = structuredClone({ ...input, next })
      if (owner.validateTransfer) await owner.validateTransfer(mutation)
      else await owner.validateMutation?.(mutation)
    }
    return next
  }

  export function creationFields(input: object | undefined, parent?: object): Record<string, unknown> {
    const raw = (input ?? {}) as Record<string, unknown>
    const inherited = (parent ?? {}) as Record<string, unknown>
    return Object.fromEntries(
      [...state().owners.values()].flatMap((owner) =>
        Object.keys(owner.shape)
          .filter((key) => key in raw || (owner.inherit?.includes(key) && key in inherited))
          .map((key) => [key, structuredClone(key in raw ? raw[key] : inherited[key])]),
      ),
    )
  }
}
