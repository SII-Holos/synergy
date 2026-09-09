import z from "zod"
import { ConfigExtensions } from "../config/extensions"
import type { ProfileId } from "../control-profile/types"
import type { SessionExtensionShape } from "./types"

export namespace SessionSchemaRegistry {
  export interface Contribution {
    shape: z.ZodRawShape
    isBackground?(input: Record<string, unknown>): boolean
    defaultControlProfile?(input: Record<string, unknown>): ProfileId | undefined
    created?(input: Record<string, unknown>): Promise<void>
    normalizeImport?(input: Record<string, unknown>, mode: "transcript" | "archive"): void
  }
  const owners = new Map<string, Contribution>()
  let generation = 0

  export function register(id: string, contribution: Contribution): void {
    if (owners.get(id) === contribution) return
    ConfigExtensions.assertRegistrationOpen(id)
    for (const [otherID, other] of owners) {
      if (otherID === id) continue
      for (const key of Object.keys(contribution.shape)) {
        if (key in other.shape) throw new Error(`Session field ${key} is already owned by ${otherID}`)
      }
    }
    owners.set(id, contribution)
    generation++
  }

  export function compose<S extends z.ZodRawShape>(
    base: z.ZodObject<S>,
  ): z.ZodObject<Omit<S, keyof SessionExtensionShape> & SessionExtensionShape> {
    let seen = -1
    let current: z.ZodObject = base
    return ConfigExtensions.dynamicSchema(() => {
      if (seen === generation) return current
      const shape = { ...base.shape }
      for (const owner of owners.values()) {
        for (const key of Object.keys(owner.shape)) {
          if (key in base.shape && key !== "workflow")
            throw new Error(`Session field ${key} is already owned by the harness`)
        }
        Object.assign(shape, owner.shape)
      }
      current = z.object(shape)
      seen = generation
      return current
    }) as z.ZodObject<Omit<S, keyof SessionExtensionShape> & SessionExtensionShape>
  }

  export function isBackground(input: object | undefined): boolean {
    if (!input) return false
    return [...owners.values()].some((owner) => owner.isBackground?.(input as Record<string, unknown>))
  }

  export function defaultControlProfile(input: object | undefined): ProfileId | undefined {
    if (!input) return undefined
    for (const owner of owners.values()) {
      const profile = owner.defaultControlProfile?.(input as Record<string, unknown>)
      if (profile) return profile
    }
  }

  export async function created(input: object): Promise<void> {
    for (const owner of owners.values()) await owner.created?.(input as Record<string, unknown>)
  }

  export function normalizeImport(input: object, mode: "transcript" | "archive"): void {
    for (const owner of owners.values()) owner.normalizeImport?.(input as Record<string, unknown>, mode)
  }

  export function creationFields(input: object | undefined): Record<string, unknown> {
    if (!input) return {}
    const raw = input as Record<string, unknown>
    return Object.fromEntries(
      [...owners.values()].flatMap((owner) =>
        Object.keys(owner.shape)
          .filter((key) => key in raw)
          .map((key) => [key, raw[key]]),
      ),
    )
  }
}
