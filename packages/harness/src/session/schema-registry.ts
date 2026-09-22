import { RuntimeContext } from "../lifecycle/context"
import z from "zod"
import { ConfigExtensions } from "../config/extensions"
import type { SessionExtensionShape } from "./types"

export namespace SessionSchemaRegistry {
  export interface Contribution {
    shape: z.ZodRawShape
    isBackground?(input: Record<string, unknown>): boolean
    created?(input: Record<string, unknown>): Promise<void>
    /** Session navigation identity this owner contributes to
     * `SessionNavEntry` (for example the Blueprint loop binding). Runs
     * synchronously inside session transactions, so it may only read the
     * already-parsed session. */
    navIdentity?(input: Record<string, unknown>): Record<string, unknown> | undefined
    normalizeImport?(input: Record<string, unknown>, mode: "transcript" | "archive"): void
  }
  const state = RuntimeContext.state(() => ({
    owners: new Map<string, Contribution>(),
    generation: 0,
    schemas: new WeakMap<object, { generation: number; schema: z.ZodObject }>(),
  }))

  export function register(id: string, contribution: Contribution): void {
    const existing = state().owners.get(id)
    if (existing === contribution) return
    if (existing) throw new Error(`Session domain ${id} is already registered`)
    ConfigExtensions.assertRegistrationOpen(id)
    for (const [otherID, other] of state().owners) {
      if (otherID === id) continue
      for (const key of Object.keys(contribution.shape)) {
        if (key in other.shape) throw new Error(`Session field ${key} is already owned by ${otherID}`)
      }
    }
    state().owners.set(id, contribution)
    state().generation++
  }

  export function compose<S extends z.ZodRawShape>(
    base: z.ZodObject<S>,
  ): z.ZodObject<Omit<S, keyof SessionExtensionShape> & SessionExtensionShape> {
    return ConfigExtensions.dynamicSchema(() => {
      const instance = state()
      const cached = instance.schemas.get(base)
      if (cached?.generation === instance.generation) return cached.schema
      const shape = { ...base.shape }
      for (const owner of state().owners.values()) {
        for (const key of Object.keys(owner.shape)) {
          if (key in base.shape && key !== "workflow")
            throw new Error(`Session field ${key} is already owned by the harness`)
        }
        Object.assign(shape, owner.shape)
      }
      const schema = z.object(shape)
      instance.schemas.set(base, { generation: instance.generation, schema })
      return schema
    }) as z.ZodObject<Omit<S, keyof SessionExtensionShape> & SessionExtensionShape>
  }

  export function isBackground(input: object | undefined): boolean {
    if (!input) return false
    return [...state().owners.values()].some((owner) => owner.isBackground?.(input as Record<string, unknown>))
  }

  export function navIdentity(input: object): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const owner of state().owners.values())
      Object.assign(result, owner.navIdentity?.(input as Record<string, unknown>))
    return result
  }

  export async function created(input: object): Promise<void> {
    for (const owner of state().owners.values()) await owner.created?.(input as Record<string, unknown>)
  }

  export function normalizeImport(input: object, mode: "transcript" | "archive"): void {
    for (const owner of state().owners.values()) owner.normalizeImport?.(input as Record<string, unknown>, mode)
  }

  export function creationFields(input: object | undefined): Record<string, unknown> {
    if (!input) return {}
    const raw = input as Record<string, unknown>
    return Object.fromEntries(
      [...state().owners.values()].flatMap((owner) =>
        Object.keys(owner.shape)
          .filter((key) => key in raw)
          .map((key) => [key, raw[key]]),
      ),
    )
  }
}
