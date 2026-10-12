import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { BlueprintLoopInfo, RuntimeCapabilities } from "@ericsanchezok/synergy-sdk/client"
import { blueprintLoopFeatureAvailable } from "./blueprint-run-session"
import { patchBlueprintLoops } from "./note-sync"

export function createBlueprintLoopsResource(input: {
  scopeID: Accessor<string | undefined>
  capabilities: Accessor<RuntimeCapabilities | undefined>
  reconnect: Accessor<number>
  list: (scopeID: string, signal: AbortSignal) => Promise<BlueprintLoopInfo[]>
}) {
  const source = createMemo(() => ({
    scopeID: input.scopeID(),
    capabilities: input.capabilities(),
    reconnect: input.reconnect(),
  }))
  const [snapshot, setSnapshot] = createSignal<{ source: ReturnType<typeof source>; loops: BlueprintLoopInfo[] }>()
  const available = (loop: { source?: string }) =>
    blueprintLoopFeatureAvailable(loop, (id) => input.capabilities()?.features.includes(id) ?? false)
  const loops = createMemo(() => {
    const value = snapshot()
    return value?.source === source() ? value.loops.filter(available) : []
  })

  createEffect(() => {
    const current = source()
    setSnapshot(undefined)
    if (!current.scopeID || !current.capabilities?.features.includes("blueprint")) return
    const cancellation = new AbortController()
    onCleanup(() => cancellation.abort())
    void input
      .list(current.scopeID, cancellation.signal)
      .then((value) => {
        if (cancellation.signal.aborted || untrack(source) !== current) return
        setSnapshot({ source: current, loops: value.filter(available).sort((a, b) => b.time.updated - a.time.updated) })
      })
      .catch((error) => {
        if (!cancellation.signal.aborted && untrack(source) === current)
          console.error("Failed to load blueprint loops", error)
      })
  })

  return {
    loops,
    update(loop: BlueprintLoopInfo) {
      const current = source()
      if (!current.scopeID || !current.capabilities?.features.includes("blueprint")) return
      const next = available(loop)
        ? patchBlueprintLoops(loops(), loop, current.scopeID)
        : loops().filter((item) => item.id !== loop.id)
      setSnapshot({ source: current, loops: next })
    },
  }
}
