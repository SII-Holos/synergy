import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export type ModelVariantKey = {
  providerID: string
  modelID: string
}

type ModelVariantState = {
  variant: Record<string, string | undefined>
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
      return store.variant[modelVariantKey(model)]
    },
    has(model: ModelVariantKey | undefined) {
      if (!model) return false
      return Object.hasOwn(store.variant, modelVariantKey(model))
    },
    set(model: ModelVariantKey | undefined, value: string | undefined) {
      if (!model) return
      setStore("variant", modelVariantKey(model), value)
    },
  }
}
