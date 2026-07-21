import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export type ModelVariantKey = {
  providerID: string
  modelID: string
}

/**
 * Variant values stored for a model.
 *
 * - absent key → never set (has() returns false)
 * - `` string → a concrete variant name
 * - `` null → explicitly cleared sentinel. SolidJS `setStore("variant", key, undefined)`
 *   deletes the property, making `Object.hasOwn` return false — indistinguishable from
 *   "never set". We store `null` instead so has() stays correct, and `get()` converts
 *   null back to undefined for callers.
 */
type ModelVariantState = {
  variant: Record<string, string | null | undefined>
}

export function modelVariantKey(model: ModelVariantKey) {
  return `${model.providerID}/${model.modelID}`
}

export function modelVariantTarget(dir: string, id: string | undefined) {
  return Persist.scoped(dir, id, "model-variant")
}

export function createModelVariantSession(dir: string, id: string | undefined) {
  const [store, setStore, _, ready] = persisted(
    modelVariantTarget(dir, id),
    createStore<ModelVariantState>({
      variant: {},
    }),
  )

  return {
    ready,
    current: createMemo(() => store.variant),
    get(model: ModelVariantKey | undefined) {
      if (!model) return undefined
      const raw = store.variant[modelVariantKey(model)]
      return raw === null ? undefined : raw
    },
    has(model: ModelVariantKey | undefined) {
      if (!model) return false
      const raw = store.variant[modelVariantKey(model)]
      // SolidJS setStore with undefined deletes the property instead of
      // storing it, so Object.hasOwn would give the wrong answer for an
      // explicit clear. We store null as the sentinel instead and test
      // whether the raw value is nullish — a never-set key has no own
      // property and returns undefined, while an explicit clear has a
      // true own-property with value null.
      return raw !== undefined || Object.hasOwn(store.variant, modelVariantKey(model))
    },
    set(model: ModelVariantKey | undefined, value: string | undefined) {
      if (!model) return
      // SolidJS setStore with undefined deletes the property, breaking
      // Object.hasOwn. Store null as the sentinel for "explicitly cleared".
      setStore("variant", modelVariantKey(model), value ?? null)
    },
  }
}
