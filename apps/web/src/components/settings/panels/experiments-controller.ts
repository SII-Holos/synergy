import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { FeatureStatus } from "@ericsanchezok/synergy-sdk/client"

export function createExperimentsController(
  api: {
    get(): Promise<FeatureStatus[]>
    update(optIn: string[]): Promise<unknown>
  },
  context: { owner: Accessor<unknown>; identity: Accessor<string>; visible: Accessor<boolean> },
) {
  const [catalog, setCatalog] = createSignal<FeatureStatus[]>([])
  const [saved, setSaved] = createSignal<string[]>([])
  const [draft, setDraft] = createSignal<string[]>([])
  const [status, setStatus] = createSignal<"idle" | "loading" | "saving" | "error">("idle")
  const [error, setError] = createSignal<{ operation: "load" | "save"; cause: unknown }>()
  const [loaded, setLoaded] = createSignal(false)
  let generation = 0
  let owner = untrack(context.owner)
  let identity = untrack(context.identity)
  let disposed = false
  onCleanup(() => {
    disposed = true
    generation++
  })
  const dirty = () => JSON.stringify([...draft()].sort()) !== JSON.stringify([...saved()].sort())
  const selected = (id: string) => draft().includes(id)
  const current = (token: number) => !disposed && generation === token && context.owner() === owner

  function accept(items: FeatureStatus[], baseline = saved()) {
    const next = items.filter((item) => item.selected && item.definition?.maturity !== "stable").map((item) => item.id)
    const merged = new Set(next)
    for (const id of new Set([...baseline, ...draft()])) {
      if (baseline.includes(id) === draft().includes(id)) continue
      if (draft().includes(id)) merged.add(id)
      else merged.delete(id)
    }
    setCatalog(items)
    setSaved(next)
    setDraft([...merged])
    setLoaded(true)
    setError(undefined)
    setStatus("idle")
  }

  async function load() {
    if (!context.owner() || status() === "saving") return
    const token = ++generation
    setStatus("loading")
    setError(undefined)
    try {
      const items = await api.get()
      if (current(token)) accept(items)
    } catch (cause) {
      if (current(token)) fail("load", cause)
    }
  }
  function fail(operation: "load" | "save", cause: unknown) {
    setError({ operation, cause })
    setStatus("error")
  }
  function toggle(id: string, enabled: boolean) {
    setDraft((value) => (enabled ? [...new Set([...value, id])] : value.filter((item) => item !== id)))
  }
  async function save() {
    if (!loaded() || !context.owner() || status() === "saving") return false
    if (!dirty()) return true
    const token = ++generation
    const submitted = [...draft()]
    setStatus("saving")
    setError(undefined)
    try {
      await api.update(submitted)
      if (!current(token)) return false
      const items = await api.get()
      if (!current(token)) return false
      accept(items, submitted)
      return true
    } catch (cause) {
      if (current(token)) fail("save", cause)
      return false
    }
  }
  function discard() {
    setDraft([...saved()])
    setError(undefined)
    if (status() === "error") setStatus("idle")
  }

  createEffect(() => {
    const nextOwner = context.owner()
    const nextIdentity = context.identity()
    if (owner !== nextOwner || identity !== nextIdentity) {
      generation++
      if (identity !== nextIdentity) {
        setDraft([])
        setSaved([])
      }
      owner = nextOwner
      identity = nextIdentity
      setCatalog([])
      setLoaded(false)
      setStatus("idle")
      setError(undefined)
    }
    if (nextOwner && context.visible() && !untrack(loaded)) untrack(() => void load())
  })
  return { catalog, draft, selected, toggle, dirty, status, loaded, error, load, save, discard }
}

export type ExperimentsController = ReturnType<typeof createExperimentsController>
