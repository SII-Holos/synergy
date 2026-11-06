import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import { blueprintLoopFeatureAvailable } from "../note/blueprint-run-session"
import { isTerminalBlueprintLoopStatus } from "./blueprint-slot"

type Epoch = { selection: unknown; reconnect: number }
type Snapshot = {
  epoch?: Epoch
  blueprint?: BlueprintLoopInfo
  blueprintBinding?: string
  blueprintRead?: string
  blueprintError?: boolean
  blueprintRevision: number
}
const caches = new WeakMap<object, Map<string, Snapshot>>()

export function createLoopStatusResource(input: {
  client: object
  owner: Accessor<{ sessionID: string; scopeID: string } | undefined>
  loopID: Accessor<string | undefined>
  reconnect: Accessor<number>
  selection: Accessor<unknown>
  hasFeature: (id: string) => boolean
  getBlueprint: (id: string, scopeID: string, signal: AbortSignal) => Promise<BlueprintLoopInfo | undefined>
}) {
  let cache = caches.get(input.client)
  if (!cache) {
    cache = new Map()
    caches.set(input.client, cache)
  }
  const retained = cache
  const [retryVersion, retry] = createSignal(0)
  const requests = new Set<AbortController>()
  let blueprintOwner: Snapshot | undefined
  onCleanup(() => {
    for (const request of requests) request.abort()
    requests.clear()
  })
  const [version, setVersion] = createSignal(0)
  const key = (owner: { sessionID: string; scopeID: string }) => JSON.stringify([owner.scopeID, owner.sessionID])
  const epoch = createMemo(() => ({ selection: input.selection(), reconnect: input.reconnect() }))
  const snapshot = createMemo(() => {
    version()
    const owner = input.owner(),
      current = epoch()
    const value = owner ? retained.get(key(owner)) : undefined
    return value && value.epoch?.selection === current.selection ? { ...value } : undefined
  })
  const touch = (owner: { sessionID: string; scopeID: string }) => {
    const id = key(owner),
      value = retained.get(id) ?? { blueprintRevision: 0 }
    retained.delete(id)
    retained.set(id, value)
    while (retained.size > 32) retained.delete(retained.keys().next().value!)
    return value
  }
  const publish = () => setVersion((v) => v + 1)
  const available = (loop: BlueprintLoopInfo) => blueprintLoopFeatureAvailable(loop, input.hasFeature)
  createEffect(() => {
    retryVersion()
    const current = epoch(),
      owner = input.owner(),
      binding = input.loopID()
    if (!owner) {
      blueprintOwner = undefined
      return
    }
    const value = touch(owner)
    if (value.epoch?.selection !== current.selection || value.epoch?.reconnect !== current.reconnect) {
      value.blueprintRead = undefined
      value.blueprintRevision++
    }
    if (
      (blueprintOwner !== value || value.blueprintBinding !== binding) &&
      (value.blueprint?.id !== binding || !isTerminalBlueprintLoopStatus(value.blueprint?.status))
    ) {
      value.blueprintRead = undefined
      value.blueprintRevision++
    }
    blueprintOwner = value
    value.blueprintBinding = binding
    value.epoch = current
    if (!binding || !input.hasFeature("blueprint")) {
      value.blueprint = undefined
      value.blueprintRead = undefined
      value.blueprintError = false
      value.blueprintRevision++
      publish()
      return
    }
    if (value.blueprintRead !== binding) {
      value.blueprintRead = binding
      value.blueprintError = false
      const request = new AbortController(),
        revision = ++value.blueprintRevision
      requests.add(request)
      void input
        .getBlueprint(binding, owner.scopeID, request.signal)
        .then((loop) => {
          if (request.signal.aborted || retained.get(key(owner)) !== value || value.blueprintRevision !== revision)
            return
          value.blueprint =
            loop &&
            loop.id === binding &&
            available(loop) &&
            loop.sessionID === owner.sessionID &&
            loop.scopeID === owner.scopeID
              ? loop
              : undefined
          value.blueprintError = !value.blueprint
          publish()
        })
        .catch(() => {
          if (value.blueprintRevision === revision && !request.signal.aborted) {
            value.blueprintRead = undefined
            value.blueprintError = true
            publish()
          }
        })
        .finally(() => requests.delete(request))
      onCleanup(() => {
        request.abort()
        if (value.blueprintRevision === revision) value.blueprintRead = undefined
      })
    }
    publish()
  })
  return {
    blueprint: () => {
      const loop = snapshot()?.blueprint
      const binding = input.loopID()
      return binding && loop?.id === binding && available(loop) ? loop : undefined
    },
    blueprintUnavailable: () => (input.loopID() ? snapshot()?.blueprintError : undefined),
    retry() {
      const owner = untrack(input.owner)
      const value = owner && retained.get(key(owner))
      if (!value || !untrack(input.loopID)) return
      value.blueprintRead = undefined
      value.blueprintError = false
      retry((n) => n + 1)
    },
    update(loop: BlueprintLoopInfo) {
      if (!available(loop)) return
      const owner = untrack(input.owner),
        id = key(loop)
      const previous = retained.get(id)
      const binding = owner && key(owner) === id ? untrack(input.loopID) : previous?.blueprintBinding
      if (!binding || loop.id !== binding) return
      if (previous?.blueprint?.id === loop.id && previous.blueprint.time.updated > loop.time.updated) return
      const value = touch(loop)
      value.blueprint = loop
      value.blueprintBinding = binding
      value.blueprintError = false
      value.blueprintRead = loop.id
      value.blueprintRevision++
      value.epoch = untrack(epoch)
      publish()
    },
  }
}
